# kamailio SMSC HTTP API to SMPP bidirectional bridge 

### Thanks to Supreeth Herle  https://github.com/herlesupreeth  for his input on this project!
#################################################################################################
### example: Kamailio SMSC - (HTTP API) <-> http-smpp-bridge - (SMPP CLient) <-> Osmocom-MSC    <- or other SMPP server. 

###  I also add a SMPP server to accept messages from a SMPP client:   SMPP Client - (SMPP server) -> http-smpp-bridge ->  (HTTP API) - Kamailio SMSC  

# install node v24.3.0 and npm

* npm install

* edit config.yaml

* npm run app   or node app.js to start the bridge


* any messages set to the SMPP server will be delivered to kamailio over the HTTP API


* edit kamailio_smsc.cfg

````
######################################################################
# SMS from other networks
######################################################################
event_route[xhttp:request] {
        if ($(hu{url.querystring}{s.len}) > 0) {
                $avp(from) = $(hu{url.querystring}{param.value,from,&});
                $avp(to) = $(hu{url.querystring}{param.value,to,&});
                $avp(text) = $(hu{url.querystring}{param.value,text,&}{s.replace,+,%20}{s.unescape.user});
                $avp(dcs) = $(hu{url.querystring}{param.value,dcs,&});

                 # set default DCS if not provided
                   if ($avp(dcs) == "") {
                         $avp(dcs) = 0;
                   }

                $avp(from_outbound) = 1;
#!ifdef WITH_DEBUG
                xlog("SMS from Outbound ($hu)\n");
                xlog("-------------------------------------\n");
                xlog("FROM $avp(from)\n");
                xlog("TO   $avp(to)\n");
                xlog("TEXT $avp(text)\n");
                xlog("DCS  $avp(dcs)\n");
#!endif
        #if ($avp(to) == "491771782261")
        #       $avp(to) = "494046895124";
        #if ($avp(to) == "491771782319")
        #       $avp(to) = "494034927220";

                route(SMS);
        }

        xhttp_reply("200", "OK", "text/html", "<html><body>OK - [$si:$sp]</body></html>");
}
````


````
######################################################################
# SMS to Outbound
######################################################################
route[SMS_TO_OUTBOUND] {
#!ifdef WITH_DEBUG
        xlog("SMS to Outbound\n");
        xlog("-------------------------------------\n");
        xlog("FROM $avp(from)\n");
        xlog("TO   $avp(to)\n");
        xlog("TEXT $avp(text)\n");
#!endif
        if ($avp(from_outbound) == 1) {
                xlog("Not sending: FROM and TO Outbound!\n");
                return 1;
                exit;
        }


        http_client_query("http://10.90.250.186:8080/send_sms?from=$avp(from)&to=$avp(to)&text=$(avp(text){s.escape.user})&dcs=$avp(dcs)", "$var(result)");
        if ($retcode != 200) return -1;
        #json_get_field("$var(result)", "messages", "$var(messages)");
        #json_get_field("$var(messages)", "status", "$var(status)");
        #if ($var(status) != 0) return -1;
        return 1;
}

````

in this next section i'm matching  the to MSISDN with the:
`if ($avp(to) == "3342012856") {
         route(SMS_TO_OUTBOUND);
                return $retcode;
            }
`
to force the message to be sent over the HTTP API

we are working on a better soultion for this.....


````
######################################################################
# SMS Handling
######################################################################
route[SMS] {
#!ifdef WITH_DEBUG
        xlog("SMS-Task\n");
        xlog("-------------------------------------\n");
        xlog("FROM $avp(from)\n");
        xlog("TO   $avp(to)\n");
        xlog("TEXT $avp(text)\n");
        xlog("DCS  $avp(dcs)\n");
#!endif

        if ($avp(to) == "3342012856") {
         route(SMS_TO_OUTBOUND);
                return $retcode;
            }


        # Query ENUM: Local number?
        #$var(enum) = "+"+$avp(to);
        #if (!enum_pv_query("$var(enum)")) {
        #       route(SMS_TO_OUTBOUND);
        #       return $retcode;
        #}
        if (sql_query("sms", "insert into messages (caller, callee, text, dcs, valid) values ('$(avp(from){s.escape.common})', '$(avp(to){s.escape.common})', '$avp(text)', $avp(dcs), now());"))
                return 1;
        else
                return -1;
}
````

and in your osmo-msc.cfg  add the smpp server:

```
smpp
 local-tcp-ip 10.90.250.42 2775
 system-id msc0
 policy closed
 smpp-first
 esme smsgw
  password smsgw
  default-route
````
