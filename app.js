const fs = require('fs');
const yaml = require('js-yaml');
const smpp = require('smpp');
const express = require('express');
const axios = require('axios');
const querystring = require('querystring');

//  load config from yaml
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

//  setup SMPP
const smppUrl = `smpp://${smppConf.ipaddress}:${smppConf.port}`;
const smppSession = smpp.connect({
  url: smppUrl,
  auto_enquire_link_period: 30000
});


smppSession.bind_transceiver({
  system_id: smppConf.system_id,
  password: smppConf.password,
  system_type: smppConf.system_type || '', // optional
  interface_version: 0x34, // SMPP v3.4
  addr_ton: 0, // Type of Number (can adjust if needed)
  addr_npi: 1, // Numbering Plan Indicator (1 = ISDN/E.164)
  address_range: ''
}, (pdu) => {
  if (pdu.command_status === 0) {
     const remoteId = pdu.system_id || '<not provided>';
     console.log(`SMPP connect: ${smppConf.ipaddress} OK, local system_id=${smppConf.system_id} remote system_id: ${remoteId}`);

  } else {
    console.error('SMPP bind failed:', pdu);
  }
});


//  Forward DeliverSM to Kamailio 
async function forwardToKamailio(from, to, message, dcs = 0) {
  const qs = querystring.stringify({
    from,
    to,
    text: message,
    dcs
  });

  const url = `${httpConf.kamailio_url}?${qs}`;

  try {
    const res = await axios.get(url);
    console.log(`Forwarded to Kamailio: ${url} -> ${res.status}`);
  } catch (err) {
    console.error('Failed to forward DeliverSM:', err.message);
  }
}

//  Handle incoming SMPP messages (deliver_sm) 
smppSession.on('pdu', async (pdu) => {
  if (pdu.command === 'deliver_sm') {
    const from = pdu.source_addr.toString();
    const to = pdu.destination_addr.toString();
    const message = pdu.short_message.message || pdu.short_message.toString();

    console.log(`DeliverSM from ${from} to ${to}: ${message}`);

    await forwardToKamailio(from, to, message);

    smppSession.deliver_sm_resp({ sequence_number: pdu.sequence_number });
  }
});

//  HTTP SERVER 
const app = express();

// Kamailio will call: GET /send_sms?from=1234&to=5678&text=Hello&dcs=0
app.get('/send_sms', (req, res) => {
  const { from, to, text, dcs } = req.query;

  if (!from || !to || !text) {
    return res.status(400).send("Missing required parameters: from, to, text");
  }
  smppSession.submit_sm({
  	source_addr: from,
 	source_addr_ton: 1,          // International    <- add to config yaml?
  	source_addr_npi: 1,          // ISDN/E.164	 <- add to config yaml?
  	destination_addr: to,
  	dest_addr_ton: 1,     // International		 <- add to config yaml?
  	dest_addr_npi: 1,     // ISDN/E.164		 <- add to config yaml?
  	short_message: text,
  	data_coding: dcs ? parseInt(dcs) : 0
  }, (pdu) => {
    if (pdu.command_status === 0) {
      console.log(`submit_sm OK -> ${to}, id: ${pdu.message_id}`);
      res.send(`OK - message_id=${pdu.message_id}`);
    } else {
      console.error('submit_sm failed', pdu);
      res.status(500).send(`Error: SMPP submit_sm failed (${pdu.command_status})`);
    }
  });
});

app.listen(httpConf.port, httpConf.bind_ip, () => {
  console.log(`HTTP API listening on ${httpConf.bind_ip}:${httpConf.port}`);
});

