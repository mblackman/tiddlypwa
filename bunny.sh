#!/bin/sh
set -e
cd output
find * -type f -exec curl --fail --request PUT \
  --url https://storage.bunnycdn.com/$BUNNY_BUCKET/{} \
  --header "AccessKey: $BUNNY_KEY" \
  --header "Content-Type: application/octet-stream" \
  --data-binary @{} \;
