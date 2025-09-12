# kamailio SMSC HTTP API to SMPP bidirectional bridge 

### Thanks to Supreeth Herle  https://github.com/herlesupreeth  for his input on this project!
#################################################################################################
### example Kanailio SMSC - (HTTP API) <-> http-smpp-bridge - SMPP <-> Osmocom-MSC    <- or other SMPP server. 

# install node v24.3.0 and npm

* npm install

* edit config.yaml

* npm run app   or node app.js to start the bridge


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

