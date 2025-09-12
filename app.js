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

const smppPeers = config.smpp_peers || [];
const httpConf = config.http_server;
const smppServerConf = config.smpp_server || { bind_ip: '0.0.0.0', port: 2775, auth: [] };
const loggingConf = config.logging || { file_path: './app.log', max_size: '20m', max_files: 5, console_enabled: true, log_level: 'debug' };

// Validate smpp_peers
if (!smppPeers.length) {
  console.error('No SMPP peers defined in config.yaml');
  process.exit(1);
}
const defaultPeer = smppPeers.find(peer => peer.default === true);
if (!defaultPeer) {
  console.warn('No default SMPP peer defined; unmatched MSISDNs will fail');
}

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
  level: loggingConf.log_level || 'debug',
  transports: transports
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

// SMPP Peer Management
const peerSessions = new Map(); // Map<peerId, { session, isBound, isConnecting, reconnectTimeout }>

function createSMPPSession(peer) {
  const smppUrl = `smpp://${peer.ipaddress}:${peer.port}`;
  if (peerSessions.has(peer.id)) {
    const { session } = peerSessions.get(peer.id);
    if (session) {
      logger.debug(`SMPP peer ${peer.id}: Closing existing session`);
      try {
        session.close();
      } catch (err) {
        logger.warn(`SMPP peer ${peer.id}: Failed to close existing session: ${err.message}`);
      }
    }
    peerSessions.delete(peer.id);
  }
  const session = smpp.connect({
    url: smppUrl,
    auto_enquire_link_period: 30000
  });
  peerSessions.set(peer.id, { session, isBound: false, isConnecting: false, reconnectTimeout: null });
  logger.debug(`SMPP peer ${peer.id}: Created new session to ${smppUrl}`);
  return session;
}

function setupPDUListener(peer, session) {
  session.removeAllListeners('pdu');
  
  session.on('pdu', async (pdu) => {
    logger.debug(`SMPP peer ${peer.id}: Received PDU: ${JSON.stringify(pdu)}`);
    logger.info(`SMPP peer ${peer.id}: Received PDU command: ${pdu.command}, status: ${pdu.command_status}`);
    
    if (pdu.command === 'deliver_sm') {
      const from = pdu.source_addr.toString();
      const to = pdu.destination_addr.toString();
      const message = pdu.short_message?.message || pdu.short_message?.toString() || '';
      const dcs = pdu.data_coding || 0;
      const esm_class = pdu.esm_class || 0;

      const isDeliveryReceipt = (esm_class & 0x04) === 0x04; // Check if delivery receipt
      logger.info(`SMPP peer ${peer.id}: Received deliver_sm from SMPP: from ${from} to ${to}: ${message}, isDeliveryReceipt=${isDeliveryReceipt}`);

      try {
        await forwardToKamailio(from, to, message, dcs);
        session.deliver_sm_resp({ sequence_number: pdu.sequence_number });
        logger.info(`SMPP peer ${peer.id}: Forwarded deliver_sm to Kamailio and sent deliver_sm_resp to SMPP peer`);
      } catch (err) {
        logger.error(`SMPP peer ${peer.id}: Failed to forward deliver_sm to Kamailio: ${err.message}`);
        session.deliver_sm_resp({ sequence_number: pdu.sequence_number });
        logger.info(`SMPP peer ${peer.id}: Sent deliver_sm_resp to SMPP peer despite forwarding error`);
      }
    }
  });
}

function connectSMPPPeer(peer) {
  const peerState = peerSessions.get(peer.id) || { session: null, isBound: false, isConnecting: false, reconnectTimeout: null };
  if (peerState.isConnecting || (peerState.session && peerState.session.connected && peerState.isBound)) {
    logger.info(`SMPP peer ${peer.id}: Connection attempt skipped: already connecting or bound`);
    return;
  }

  peerState.isConnecting = true;
  peerSessions.set(peer.id, peerState); // Ensure state is set
  logger.debug(`SMPP peer ${peer.id}: Attempting connection to smpp://${peer.ipaddress}:${peer.port}`);

  const session = createSMPPSession(peer);

  session.on('connect', () => {
    logger.debug(`SMPP peer ${peer.id}: TCP connected, binding...`);
    logger.debug(`SMPP peer ${peer.id}: Binding with system_id=${peer.system_id}, system_type=${peer.system_type || ''}`);
    session.bind_transceiver({
      system_id: peer.system_id,
      password: peer.password,
      system_type: peer.system_type || '',
      interface_version: 0x34, // SMPP v3.4
      address_range: ''
    }, (pdu) => {
      peerState.isConnecting = false;
      logger.debug(`SMPP peer ${peer.id}: Bind response: ${JSON.stringify(pdu)}`);
      logger.debug(`SMPP peer ${peer.id}: Bind response: command_status=${pdu.command_status}, full PDU: ${JSON.stringify(pdu)}`);
      
      if (pdu.command_status === 0) {
        const remoteId = pdu.system_id || '<not provided>';
        logger.info(`SMPP peer ${peer.id}: Connect to ${peer.ipaddress} OK, local system_id=${peer.system_id} remote system_id: ${remoteId}`);
        peerState.isBound = true;
        peerState.session = session; // Ensure session is set
        peerSessions.set(peer.id, peerState); // Update state
        setupPDUListener(peer, session);
        logger.debug(`SMPP peer ${peer.id}: PDU listener attached, ready for deliver_sm`);
      } else {
        let errorMsg = `SMPP peer ${peer.id}: Bind failed with status ${pdu.command_status}`;
        if (pdu.command_status === 13) errorMsg += ' (ESME_RBINDFAIL - invalid system_id/password/system_type)';
        if (pdu.command_status === 14) errorMsg += ' (ESME_RINVPASWD - invalid password)';
        logger.error(errorMsg);
        peerState.isBound = false;
        peerState.session = null; // Clear session on bind failure
        peerSessions.set(peer.id, peerState); // Update state
        scheduleReconnect(peer);
      }
    });
  });

  session.on('close', () => {
    logger.warn(`SMPP peer ${peer.id}: Connection closed`);
    logger.debug(`SMPP peer ${peer.id}: Session closed, resetting state`);
    peerState.isBound = false;
    peerState.isConnecting = false;
    peerState.session = null; // Clear session
    peerSessions.set(peer.id, peerState); // Update state
    scheduleReconnect(peer);
  });

  session.on('error', (err) => {
    logger.error(`SMPP peer ${peer.id}: Error: ${err.message}`);
    logger.debug(`SMPP peer ${peer.id}: Error details: ${err.stack}`);
    peerState.isBound = false;
    peerState.isConnecting = false;
    peerState.session = null; // Clear session
    peerSessions.set(peer.id, peerState); // Update state
    scheduleReconnect(peer);
  });

  session.on('enquire_link', (pdu) => {
    logger.debug(`SMPP peer ${peer.id}: Received enquire_link PDU`);
    logger.info(`SMPP peer ${peer.id}: Received enquire_link, responding`);
    session.send(pdu.response());
  });
}

function scheduleReconnect(peer) {
  const peerState = peerSessions.get(peer.id);
  if (peerState.reconnectTimeout) {
    clearTimeout(peerState.reconnectTimeout);
    logger.debug(`SMPP peer ${peer.id}: Cleared existing reconnect timeout`);
  }
  peerState.reconnectTimeout = setTimeout(() => {
    peerState.reconnectTimeout = null;
    logger.debug(`SMPP peer ${peer.id}: Initiating reconnect`);
    connectSMPPPeer(peer);
  }, peer.reconnect_interval || 10000);
  peerSessions.set(peer.id, peerState); // Update state
}

// Route submit_sm to appropriate peer
function routeToPeer(to) {
  logger.debug(`SMPP routing: Checking peers for destination ${to}`);
  for (const peer of smppPeers) {
    const peerState = peerSessions.get(peer.id);
    logger.debug(`SMPP peer ${peer.id}: State - isBound=${peerState?.isBound}, isConnecting=${peerState?.isConnecting}, session=${!!peerState?.session}`);
    if (!peerState || !peerState.isBound || !peerState.session) {
      logger.debug(`SMPP peer ${peer.id}: Skipped, not bound or no valid session`);
      continue;
    }
    if (peer.route_regex) {
      try {
        const regex = new RegExp(peer.route_regex);
        if (regex.test(to)) {
          logger.info(`SMPP routing: Selected peer ${peer.id} for destination ${to} (matched ${peer.route_regex})`);
          return peer;
        }
      } catch (err) {
        logger.error(`SMPP peer ${peer.id}: Invalid route_regex ${peer.route_regex}: ${err.message}`);
      }
    }
  }
  if (defaultPeer) {
    const peerState = peerSessions.get(defaultPeer.id);
    logger.debug(`SMPP default peer ${defaultPeer.id}: State - isBound=${peerState?.isBound}, isConnecting=${peerState?.isConnecting}, session=${!!peerState?.session}`);
    if (peerState && peerState.isBound && peerState.session) {
      logger.info(`SMPP routing: Selected default peer ${defaultPeer.id} for destination ${to}`);
      return defaultPeer;
    } else {
      logger.warn(`SMPP routing: Default peer ${defaultPeer.id} not bound or no valid session for destination ${to}`);
    }
  }
  logger.warn(`SMPP routing: No bound peer with valid session found for destination ${to}`);
  return null;
}

// Wait for at least one peer to be bound
async function waitForBoundPeer(timeout = 15000) {
  const start = Date.now();
  logger.debug(`SMPP: Starting waitForBoundPeer with timeout ${timeout}ms`);
  while (Date.now() - start < timeout) {
    let boundPeerCount = 0;
    for (const peer of smppPeers) {
      const peerState = peerSessions.get(peer.id);
      logger.debug(`SMPP waitForBoundPeer: Checking peer ${peer.id} - isBound=${peerState?.isBound}, isConnecting=${peerState?.isConnecting}, session=${!!peerState?.session}`);
      if (peerState && peerState.isBound && peerState.session) {
        logger.debug(`SMPP peer ${peer.id}: Found bound peer with valid session`);
        boundPeerCount++;
      }
    }
    if (boundPeerCount > 0) {
      logger.debug(`SMPP waitForBoundPeer: Found ${boundPeerCount} bound peer(s)`);
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  logger.warn(`SMPP waitForBoundPeer: No peers bound with valid session after ${timeout}ms timeout`);
  return false;
}

// Connect all SMPP peers
smppPeers.forEach(peer => {
  if (!peer.id) {
    logger.error('SMPP peer missing id in config');
    return;
  }
  peerSessions.set(peer.id, { session: null, isBound: false, isConnecting: false, reconnectTimeout: null });
  connectSMPPPeer(peer);
});

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
      logger.error(`SMPP server: Rejected bind_transmitter from ${system_id} (invalid credentials)`);
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

// Forward DeliverSM to Kamailio with retry
async function forwardToKamailio(from, to, message, dcs = 0, retries = 3, retryDelay = 1000) {
  const qs = querystring.stringify({
    from,
    to,
    text: message,
    dcs
  });

  const url = `${httpConf.kamailio_url}?${qs}`;
  logger.debug(`Forwarding to Kamailio: URL=${url}, from=${from}, to=${to}, text=${message}, dcs=${dcs}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 5000 }); // 5-second timeout
      logger.info(`Forwarded to Kamailio: ${url} -> ${res.status}`);
      logger.debug(`Kamailio response: status=${res.status}, data=${JSON.stringify(res.data)}`);
      return;
    } catch (err) {
      logger.error(`Kamailio attempt ${attempt}/${retries} failed: ${err.message}`);
      logger.debug(`Kamailio error details: ${err.stack}`);
      if (attempt < retries) {
        logger.debug(`Retrying Kamailio request in ${retryDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        throw err; // Throw on final attempt
      }
    }
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
app.get('/send_sms', async (req, res) => {
  const { from, to, text, dcs } = req.query;

  logger.debug(`HTTP /send_sms: Received dcs=${dcs}`);

  if (!from || !to || !text) {
    logger.warn('HTTP /send_sms: Missing required parameters');
    return res.status(400).send("Missing required parameters: from, to, text");
  }

  // Wait for a bound peer
  const isPeerBound = await waitForBoundPeer();
  if (!isPeerBound) {
    logger.warn('HTTP /send_sms: No bound SMPP peer with valid session available after timeout');
    return res.status(503).send('No SMPP peer available');
  }

  const peer = routeToPeer(to);
  if (!peer) {
    logger.warn('HTTP /send_sms: No bound SMPP peer with valid session available for routing');
    return res.status(503).send('No SMPP peer available');
  }

  const peerState = peerSessions.get(peer.id);
  if (!peerState.session) {
    logger.error(`SMPP peer ${peer.id}: No valid session, attempting reconnect`);
    peerState.isBound = false;
    peerState.isConnecting = false;
    peerSessions.set(peer.id, peerState);
    connectSMPPPeer(peer);
    return res.status(503).send('No valid SMPP session, retry later');
  }

  logger.debug(`SMPP peer ${peer.id}: Sending submit_sm: from=${from}, to=${to}, text=${text}, dcs=${dcs}`);
  peerState.session.submit_sm({
    source_addr: from,
    source_addr_ton: peer.source_addr_ton || 1,
    source_addr_npi: peer.source_addr_npi || 1,
    destination_addr: to,
    dest_addr_ton: peer.dest_addr_ton || 1,
    dest_addr_npi: peer.dest_addr_npi || 1,
    short_message: text,
    data_coding: dcs ? parseInt(dcs) : 0,
    registered_delivery: 1 // Request delivery receipts
  }, (pdu) => {
    logger.debug(`SMPP peer ${peer.id}: submit_sm response: ${JSON.stringify(pdu)}`);
    if (pdu.command_status === 0) {
      const messageId = pdu.message_id && pdu.message_id !== 'msg_id_not_implemented' ? pdu.message_id : `app-${Date.now()}`;
      logger.info(`SMPP peer ${peer.id}: submit_sm OK -> ${to}, id: ${messageId}`);
      res.send(`OK - message_id=${messageId}`);
    } else {
      logger.error(`SMPP peer ${peer.id}: submit_sm failed`, pdu);
      res.status(500).send(`Error: SMPP submit_sm failed (${pdu.command_status})`);
    }
  });
});

app.listen(httpConf.port, httpConf.bind_ip, () => {
  logger.info(`HTTP API listening on ${httpConf.bind_ip}:${httpConf.port}`);
});
