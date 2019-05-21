#!/bin/sh -x

KILL_CMD=pkill
CONFIG_FILE=config/$(hostname -s)-config.json

$KILL_CMD node

sleep 2

if [ ! -d logs ]; then
  mkdir logs
fi

nohup ./built/dns.js $CONFIG_FILE 2>&1 | svlogd logs &
