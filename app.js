const fs = require('fs');
const yaml = require('js-yaml');
const smpp = require('smpp');
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const winston = require('winston');

// Load config from yaml
let config;
try {
  const file = fs.readFileSync('./config.yaml', 'utf8');
  config = yaml.load(file);
} catch (e) {
  console.error('Failed to load config.yaml:', e);
  process.exit(1);
}

const smppConf = config.smpp_peer;
const httpConf = config.http_server;
const smppServerConf = config.smpp_server || { bind_ip: '0.0.0.0', port: 2776, auth: [] };
const loggingConf = config.logging || { file_path: './logs/app.log', max_size: '20m', max_files: 5, console_enabled: true, log_level: 'info' };

// Setup Winston logger
const transports = [
  new winston.transports.File({
    filename: loggingConf.file_path,
    maxsize: parseSize(loggingConf.max_size),
    maxFiles: loggingConf.max_files,
    tailable: true,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    )
  })
];

if (loggingConf.console_enabled) {
  transports.push(
    new winston.transports.Console({
      format: winston.format.simple()
    })
  );
}

const logger = winston.createLogger({
  level: loggingConf.log_level || 'info',
  transports
});

// Helper function to parse size strings (e.g., '20m' -> 20MB)
function parseSize(sizeStr) {
  const units = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  const match = sizeStr.match(/^(\d+)([kmg]?)$/i);
  if (!match) return 20 * 1024 * 1024; // Default to 20MB
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  return num * (units[unit] || 1);
}

// Setup SMPP Client
const smppUrl = `smpp://${smppConf.ipaddress}:${smppConf.port}`;
let smppSession = null;
let isConnecting = false;
let reconnectTimeout = null;
let isBound = false; // Track bound state

function createSMPPSession() {
  if (smppSession) {
    logger.debug('SMPP client: Closing existing session');
    smppSession.close();
    smppSession = null;
    isBound = false;
  }
  smppSession = smpp.connect({
    url: smppUrl,
    auto_enquire_link_period: 30000
  });
  logger.debug(`SMPP client: Created new session to ${smppUrl}`);
  return smppSession;
}

function setupPDUListener() {
  // Remove any existing listener to avoid duplicates
  smppSession.removeAllListeners('pdu');
  
  smppSession.on('pdu', async (pdu) => {
    logger.debug(`SMPP client: Received PDU: ${JSON.stringify(pdu)}`);
    //logger.info(`SMPP client: Received PDU command: ${pdu.command}, status: ${pdu.command_status}`);
    
    if (pdu.command === 'deliver_sm') {
      const from = pdu.source_addr.toString();
      const to = pdu.destination_addr.toString();
      const message = pdu.short_message.message || pdu.short_message.toString();

      logger.debug(`SMPP client: Received deliver_sm from SMPP: from ${from} to ${to}: ${message}`);

      try {
        await forwardToKamailio(from, to, message);
        smppSession.deliver_sm_resp({ sequence_number: pdu.sequence_number });
        logger.debug(`SMPP client: Forwarded deliver_sm to Kamailio and sent deliver_sm_resp to SMPP peer`);
      } catch (err) {
        logger.error(`SMPP client: Failed to forward deliver_sm to Kamailio: ${err.message}`);
        // Still acknowledge to avoid SMSC resends
        smppSession.deliver_sm_resp({ sequence_number: pdu.sequence_number });
        logger.info(`SMPP client: Sent deliver_sm_resp to smpp peer despite forwarding error`);
      }
    }
  });
}

function connectSMPP() {
  if (isConnecting || (smppSession && smppSession.connected && isBound)) {
    logger.info('SMPP client connection attempt skipped: already connecting or bound');
    return;
  }

  isConnecting = true;
  logger.debug(`Attempting SMPP client connection to ${smppUrl}`);

  const session = createSMPPSession();

  session.on('connect', () => {
    logger.debug('SMPP client: TCP connected, binding...');
    logger.debug(`SMPP client: Binding with system_id=${smppConf.system_id}, system_type=${smppConf.system_type || ''}`);
    session.bind_transceiver({
      system_id: smppConf.system_id,
      password: smppConf.password,
      system_type: smppConf.system_type || '',
      interface_version: 0x34, // SMPP v3.4
      address_range: ''
    }, (pdu) => {
      isConnecting = false;
      logger.debug(`SMPP client bind response: ${JSON.stringify(pdu)}`);
      logger.debug(`SMPP client bind response: command_status=${pdu.command_status}, full PDU: ${JSON.stringify(pdu)}`);
      
      if (pdu.command_status === 0) {
        const remoteId = pdu.system_id || '<not provided>';
        logger.info(`SMPP client connect: ${smppConf.ipaddress} OK, local system_id=${smppConf.system_id} remote system_id: ${remoteId}`);
        isBound = true;
        setupPDUListener(); // Attach listener only after successful bind
        logger.debug('SMPP client: PDU listener attached, ready for deliver_sm');
      } else {
        // Common errors: 13=ESME_RBINDFAIL (invalid creds), 14=ESME_RINVPASWD
        let errorMsg = `SMPP client bind failed with status ${pdu.command_status}`;
        if (pdu.command_status === 13) errorMsg += ' (ESME_RBINDFAIL - invalid system_id/password/system_type)';
        if (pdu.command_status === 14) errorMsg += ' (ESME_RINVPASWD - invalid password)';
        logger.error(errorMsg);
        isBound = false;
        scheduleReconnect();
      }
    });
  });

  session.on('close', () => {
    logger.warn('SMPP client connection closed');
    logger.debug('SMPP client: Session closed, resetting bound state');
    isBound = false;
    isConnecting = false;
    scheduleReconnect();
  });

  session.on('error', (err) => {
    logger.error(`SMPP client error: ${err.message}`);
    logger.debug(`SMPP client: Error details: ${err.stack}`);
    isBound = false;
    isConnecting = false;
    scheduleReconnect();
  });

  // Handle enquire_link for keep-alive
  session.on('enquire_link', (pdu) => {
    logger.debug('SMPP client: Received enquire_link PDU');
    logger.info('SMPP client: Received enquire_link, responding');
    session.send(pdu.response());
  });
}

function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    logger.debug('SMPP client: Cleared existing reconnect timeout');
  }
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    logger.debug('SMPP client: Initiating reconnect');
    connectSMPP();
  }, smppConf.reconnect_interval || 10000);
}

// Setup SMPP Server
const smppServer = smpp.createServer();

smppServer.on('session', (session) => {
  logger.info('New SMPP server session initiated');
  logger.debug('SMPP server: New session created');

  session.on('bind_transceiver', (pdu) => {
    const { system_id, password } = pdu;
    logger.debug(`SMPP server: Received bind_transceiver from ${system_id}, PDU: ${JSON.stringify(pdu)}`);
    const isAuthenticated = smppServerConf.auth.some(
      (cred) => cred.system_id === system_id && cred.password === password
    );

    if (isAuthenticated) {
      session.send(pdu.response({
        system_id: 'SMPP-GATEWAY'
      }));
      logger.info(`SMPP server: Accepted bind_transceiver from ${system_id}`);
    } else {
      session.send(pdu.response({
        command_status: smpp.ESME_RBINDFAIL
      }));
      logger.error(`SMPP server: Rejected bind_transceiver from ${system_id} (invalid credentials)`);
      session.close();
    }
  });

  session.on('bind_transmitter', (pdu) => {
    const { system_id, password } = pdu;
    logger.debug(`SMPP server: Received bind_transmitter from ${system_id}, PDU: ${JSON.stringify(pdu)}`);
    const isAuthenticated = smppServerConf.auth.some(
      (cred) => cred.system_id === system_id && cred.password === password
    );

    if (isAuthenticated) {
      session.send(pdu.response({
        system_id: 'SMPP-GATEWAY'
      }));
      logger.info(`SMPP server: Accepted bind_transmitter from ${system_id}`);
    } else {
      session.send(pdu.response({
        command_status: smpp.ESME_RBINDFAIL
      }));
      logger.error(`SMPP server: Rejected bind_transceiver from ${system_id} (invalid credentials)`);
      session.close();
    }
  });

  session.on('submit_sm', async (pdu) => {
    const from = pdu.source_addr.toString();
    const to = pdu.destination_addr.toString();
    const message = pdu.short_message?.message || pdu.short_message?.toString() || '';
    const dcs = pdu.data_coding || 0;

    logger.debug(`SMPP server: Received submit_sm PDU: ${JSON.stringify(pdu)}`);
    logger.info(`SMPP server: Received submit_sm from ${from} to ${to}: ${message}`);

    try {
      await forwardToKamailio(from, to, message, dcs);
      session.send(pdu.response({
        message_id: `msg-${Date.now()}`
      }));
      logger.info(`SMPP server: Forwarded submit_sm to Kamailio, responded with message_id`);
    } catch (err) {
      logger.error(`SMPP server: Failed to forward submit_sm to Kamailio: ${err.message}`);
      session.send(pdu.response({
        command_status: smpp.ESME_RSYSERR
      }));
    }
  });

  session.on('error', (err) => {
    logger.error('SMPP server session error:', err.message);
    logger.debug(`SMPP server: Session error details: ${err.stack}`);
  });

  session.on('close', () => {
    logger.info('SMPP server session closed');
    logger.debug('SMPP server: Session closed');
  });
});

smppServer.listen(smppServerConf.port, smppServerConf.bind_ip, () => {
  logger.info(`SMPP server listening on ${smppServerConf.bind_ip}:${smppServerConf.port}`);
});

// Forward DeliverSM to Kamailio
async function forwardToKamailio(from, to, message, dcs = 0) {
  const qs = querystring.stringify({
    from,
    to,
    text: message,
    dcs
  });

  const url = `${httpConf.kamailio_url}?${qs}`;

  logger.debug(`Forwarding to Kamailio: URL=${url}`);
  try {
    const res = await axios.get(url);
    logger.info(`Forwarded to Kamailio: ${url} -> ${res.status}`);
    logger.debug(`Kamailio response: status=${res.status}, data=${JSON.stringify(res.data)}`);
  } catch (err) {
    logger.error('Failed to forward DeliverSM:', err.message);
    logger.debug(`Kamailio error details: ${err.stack}`);
    throw err;
  }
}

// HTTP SERVER
const app = express();

// Log every HTTP request
app.use((req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  logger.debug(`HTTP request received: ${clientIp} ${req.method} ${req.originalUrl}, headers=${JSON.stringify(req.headers)}`);
  logger.info(`HTTP request: ${clientIp} ${req.method} ${req.originalUrl}`);
  next();
});

// Kamailio will call: GET /send_sms?from=1234&to=5678&text=Hello&dcs=0
app.get('/send_sms', (req, res) => {
  const { from, to, text, dcs } = req.query;

  if (!from || !to || !text) {
    logger.warn('HTTP /send_sms: Missing required parameters');
    return res.status(400).send("Missing required parameters: from, to, text");
  }

  if (!isBound) {
    logger.warn('SMPP client not bound, cannot submit_sm');
    return res.status(503).send('SMPP client not connected');
  }

  logger.debug(`SMPP client: Sending submit_sm: from=${from}, to=${to}, text=${text}, dcs=${dcs}`);
  smppSession.submit_sm({
    source_addr: from,
    source_addr_ton: smppConf.source_addr_ton || 1,
    source_addr_npi: smppConf.source_addr_npi || 1,
    destination_addr: to,
    dest_addr_ton: smppConf.dest_addr_ton || 1,
    dest_addr_npi: smppConf.dest_addr_npi || 1,
    short_message: text,
    data_coding: dcs ? parseInt(dcs) : 0
  }, (pdu) => {
    logger.debug(`SMPP client: submit_sm response: ${JSON.stringify(pdu)}`);
    if (pdu.command_status === 0) {
      logger.info(`SMPP client: submit_sm OK -> ${to}, id: ${pdu.message_id}`);
      res.send(`OK - message_id=${pdu.message_id}`);
    } else {
      logger.error('SMPP client: submit_sm failed', pdu);
      res.status(500).send(`Error: SMPP submit_sm failed (${pdu.command_status})`);
    }
  });
});

app.listen(httpConf.port, httpConf.bind_ip, () => {
  logger.info(`HTTP API listening on ${httpConf.bind_ip}:${httpConf.port}`);
});

// Initial SMPP client connection
connectSMPP();
