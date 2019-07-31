#!/bin/sh -x

CONFIG_FILE=config/$(hostname -s)-config.json

pkill -f 'node ./built/dns-proxy.js'

sleep 2

if [ ! -d logs ]; then
  mkdir logs
fi

nohup ./built/dns-proxy.js $CONFIG_FILE >> logs/output 2>&1 &
