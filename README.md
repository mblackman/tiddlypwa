[![Support me on Patreon](https://img.shields.io/badge/dynamic/json?logo=patreon&color=%23e85b46&label=support%20me%20on%20patreon&query=data.attributes.patron_count&suffix=%20patrons&url=https%3A%2F%2Fwww.patreon.com%2Fapi%2Fcampaigns%2F9395291)](https://www.patreon.com/valpackett)

# TiddlyPWA

TiddlyPWA turns TiddlyWiki into an **offline-first** Progressive Web App with **encrypted** local persistent storage
and efficient **synchronization** with a server that can easily be hosted for free.

To learn more, visit:

https://tiddly.packett.cool

## Development Notes

`deno fmt` must be used for formatting.

Building the html files (assuming Notebook theme repo cloned in the listed directory):

```shell
TIDDLYWIKI_THEME_PATH=$HOME/src/github.com/paul-rouse/Notebook/themes TIDDLYWIKI_PLUGIN_PATH=$HOME/src/github.com/paul-rouse/Notebook/plugins npx tiddlywiki@5.3.5 --build
```

## Docker Setup

### Running with Docker Compose

A ready-to-run [docker-compose.yml](file:///Users/mblackman/workspace/gh/tiddlypwa/docker-compose.yml) is included. You can use the pre-built container image or build it locally:

```yaml
services:
  tiddlypwa:
    image: ghcr.io/mblackman/tiddlypwa:latest
    container_name: tiddlypwa
    restart: unless-stopped
    ports:
      - '8000:8000'
    environment:
      - ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}
      - ADMIN_PASSWORD_SALT=${ADMIN_PASSWORD_SALT}
      - DB_PATH=/data/pwa.db
    volumes:
      - /path/to/data:/data
```

### Generating Admin Password Hash and Salt

You can generate the Argon2 admin hash and salt directly using the container:

```shell
docker run -it --rm ghcr.io/mblackman/tiddlypwa:latest hash
```
