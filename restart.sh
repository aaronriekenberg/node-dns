#!/bin/sh -x

KILL_CMD=pkill

$KILL_CMD node

sleep 2

if [ ! -d logs ]; then
  mkdir logs
fi

nohup ./built/server.js 2>&1 | svlogd logs &
