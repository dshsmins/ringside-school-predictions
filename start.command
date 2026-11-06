#!/bin/zsh
set -e
cd -- "${0:A:h}"
node server.mjs
