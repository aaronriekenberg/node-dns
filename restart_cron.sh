#!/bin/sh

pgrep -f 'node ./built/dns.js' > /dev/null 2>&1
if [ $? -eq 1 ]; then
  cd ~/node-dns
  ./restart.sh > /dev/null 2>&1
fi
