#!/usr/bin/env bash
export PATH="/home/gcalleja/.nvm/versions/node/v24.16.0/bin:$PATH"
exec npx tsx src/index.ts "$@"
