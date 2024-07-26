[![CI status](https://ci.codeberg.org/api/badges/valpackett/tiddlypwa/status.svg)](https://ci.codeberg.org/valpackett/tiddlypwa)
[![Netlify Status](https://api.netlify.com/api/v1/badges/2c2cbd41-1ced-4f78-acc7-83889f95bcc2/deploy-status)](https://app.netlify.com/sites/tiddly-packett-cool/deploys)
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
