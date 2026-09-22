#!/bin/sh
set -e

if [ -z "$BUNNY_BUCKET" ] || [ -z "$BUNNY_KEY" ]; then
  echo "Error: BUNNY_BUCKET and BUNNY_KEY environment variables must be set." >&2
  exit 1
fi

cd output
find * -type f -exec curl --fail --request PUT \
  --url "https://storage.bunnycdn.com/$BUNNY_BUCKET/{}" \
  --header "AccessKey: $BUNNY_KEY" \
  --data-binary @{} \;
