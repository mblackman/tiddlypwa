# Web Push Notifications & Developer Guide

**TiddlyPWA** includes a zero-dependency Web Push notification engine (RFC 8292 VAPID + RFC 8291 `aes128gcm`) and a **three-tier extension system** for authoring push notifications inside your own TiddlyWiki or TiddlyWiki plugins.

---

## 1. Enabling Push Notifications in Your Wiki

Before authoring notifications, enable Web Push on your device:

1. Ensure your TiddlyPWA wiki is synced with a TiddlyPWA server (`$:/ControlPanel` → **TiddlyPWA** → **Synchronization**).
2. Scroll down to **Push Notifications** in the TiddlyPWA Control Panel tab (or open `$:/plugins/mblackman/tiddlypwa/config-push`).
3. Click **Enable Push Notifications on This Device** and grant browser notification permission.
4. Click **Send Test Push** to verify end-to-end delivery.

> **Browser Requirements**: Web Push requires a Secure Context (`https://` in production, or `http://localhost` / `http://127.0.0.1` during local development). On iOS/iPadOS, the wiki must first be added to the Home Screen.

---

## 2. Choosing the Right Notification Tier

TiddlyPWA provides three complementary tiers depending on how your notification is triggered:

| Tier       | Mechanism                      | Where It Runs                                                      | Payload Privacy                                                    | Default Delivery Scope                 | Best For                                                                                                    |
| :--------- | :----------------------------- | :----------------------------------------------------------------- | :----------------------------------------------------------------- | :------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| **Tier 1** | `module-type: pwa-watcher`     | Server (Sandboxed Deno Worker on cron schedule)                    | Plaintext on server (encrypted in transit via RFC 8291)            | All subscribed devices for the wiki    | Polling external websites, RSS/Atom feeds, JSON APIs, or price/deal trackers while your devices are offline |
| **Tier 2** | `$:/tags/NotificationRule`     | Evaluated on client when tiddlers change; scheduled on server      | **Zero-knowledge** (`AES-GCM-256` encrypted with client `pushKey`) | All subscribed devices for the wiki    | Due dates, task reminders, calendar events, and recurring review prompts driven by tiddler fields           |
| **Tier 3** | `tm-pwa-schedule-notification` | Triggered on client via wikitext button or JS; scheduled on server | **Zero-knowledge** (`AES-GCM-256` encrypted with client `pushKey`) | Current device only (or `scope="all"`) | Interactive timers, Pomodoro alerts, snooze buttons, and one-off reminders                                  |

---

## 3. Tier 1: Sandboxed Server Watchers (`module-type: pwa-watcher`)

Tier 1 watchers are JavaScript ES module tiddlers that you write in your TiddlyWiki. When you create or edit a watcher tiddler, TiddlyPWA signs its code and configuration with your client-side Ed25519 key (`watcherSignKey`) and syncs it to the server.

The server executes your watcher on its cron schedule inside an **isolated, zero-permission Deno Worker** (`permissions: "none"`, 10-second timeout) and proxies outbound HTTP requests only to domains listed in your `allowed-hosts` field (with DNS/IP SSRF validation).

### 3.1 Watcher Tiddler Fields

Create a tiddler with `type: application/javascript` and `module-type: pwa-watcher`:

| Field           | Required | Description                                                                                                                                                                                                                       |
| :-------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`          | **Yes**  | Must be `application/javascript`.                                                                                                                                                                                                 |
| `module-type`   | **Yes**  | Must be `pwa-watcher`. (TiddlyPWA automatically excludes `pwa-watcher` tiddlers from browser boot execution and reload warnings.)                                                                                                 |
| `watcher-id`    | **Yes**  | Unique identifier for this watcher (e.g., `myplugin.hn.rss`). Used to scope persistent server state (`state_json`).                                                                                                               |
| `schedule-cron` | **Yes**  | Standard 5-field cron expression (`minute hour day-of-month month day-of-week`, e.g., `0 */6 * * *` for every 6 hours, or `*/15 * * * *` for every 15 minutes). Evaluated in your browser's IANA timezone (synced automatically). |
| `allowed-hosts` | **Yes**  | Comma-separated list of allowed outbound hostnames (e.g., `news.ycombinator.com, api.github.com`). Subdomains of listed hosts are also permitted.                                                                                 |
| `config-filter` | No       | TiddlyWiki filter selecting tiddlers to snapshot and pass into `context.items` on the server (e.g., `[tag[Watchlist]!has[draft.of]]`).                                                                                            |
| `enabled`       | No       | Set to `no` or `false` to disable the watcher on the server without deleting the tiddler. Defaults to enabled (`yes`).                                                                                                            |

### 3.2 Module Contract: `export async function evaluate(context, host)`

Your watcher tiddler must export an async `evaluate(context, host)` function:

```javascript
export async function evaluate(context, host) {
	// context.watcherId: string ("myplugin.hn.rss")
	// context.now: number (epoch ms)
	// context.items: Array<{ title, text, tags, fields }> (tiddlers matched by config-filter)
	// context.state: Record<string, any> (persistent JSON state from previous runs)
	return [];
}
```

### 3.3 The `host` Scraping & State API

Inside `evaluate(context, host)`, the `host` object provides asynchronous helpers:

- **`await host.fetch(url, options?)`**
  Fetches an HTTP/HTTPS URL whose hostname matches `allowed-hosts`. Automatically sends cached `If-None-Match` (`ETag`) and `If-Modified-Since` (`Last-Modified`) headers from previous runs.
  - `options`: `{ method?: 'GET' | 'HEAD', headers?: Record<string, string>, timeoutMs?: number }`
  - Returns:
    ```ts
    {
    	ok: boolean; // true if status is 200..299 (false on 304 Not Modified)
    	status: number; // HTTP status code
    	notModified: boolean; // true if server returned 304 Not Modified
    	body: string; // Response text (up to 2 MB)
    	headers: Record<string, string>;
    }
    ```
- **`await host.extractJsonLd(html, schemaType?)`**
  Extracts and parses all `<script type="application/ld+json">` blocks from an HTML string (flattening `@graph` arrays). If `schemaType` is provided (e.g., `'Product'` or `'Book'`), filters to matching `@type` objects.
- **`await host.queryHtml(html, cssSelector)`**
  Parses HTML using `linkedom` on the server and returns an array of matching elements:
  `Array<{ tag: string, text: string, html: string, attrs: Record<string, string> }>`.
- **`await host.parseXml(xml)`**
  Parses RSS 2.0 (`<item>`) or Atom (`<entry>`) XML feeds and returns:
  `{ items: Array<{ title: string, link: string, guid: string, pubDate: string, description: string }> }`.
- **`await host.matchRegex(text, pattern, flags?)`**
  Runs `new RegExp(pattern, flags)` against `text` and returns an array of match capture arrays (`string[][]`).
- **`await host.getState(key)` / `await host.setState(key, value)`**
  Reads or updates a key in the watcher's persistent server-side `state_json` (committed transactionally when the run succeeds).

### 3.4 Return Value Contract

`evaluate(context, host)` returns an array of result objects (up to 25 per run). Each item can send a push notification, stage a tiddler patch/creation for the next wiki sync, or attach deferred patches to notification action buttons:

```javascript
return [
	{
		// Optional: target title if patching a specific tiddler from context.items
		itemTitle: 'My Tracked Item',

		// Optional: send a Web Push notification
		notify: {
			title: 'Price Drop Alert',
			body: 'Now $9.99 (target: $12.00)',
			tag: 'price-drop:item-1',
			// Click behavior (choose one):
			navigateTo: 'My Tracked Item', // Open this tiddler in TiddlyWiki
			// openUrl: 'https://example.com/p', // Or open an external URL directly
			// clickAction: 'none',              // Or only focus the wiki without navigating
			actions: [
				{ action: 'mark-bought', title: 'Mark Bought' },
				{ action: 'open-store', title: 'Open Store' },
			],
		},

		// Optional: automatically patch `itemTitle` (or `patchTarget.title`) on next wiki sync
		patchTarget: {
			title: 'My Tracked Item',
			setFields: { 'current-price': '9.99', 'last-checked': '20261025120000000' },
			addTags: ['OnSale'],
			removeTags: ['Waiting'],
		},

		// Optional: automatically create a new tiddler on next wiki sync
		createTiddler: {
			title: 'Clipped Article',
			text: 'Article summary...',
			tags: ['Inbox', 'Clipped'],
			fields: { 'source-url': 'https://example.com/article' },
		},

		// Optional: run patches or open URLs ONLY when the user clicks a specific action button
		actionPatches: {
			'mark-bought': {
				patchTarget: {
					title: 'My Tracked Item',
					setFields: { status: 'bought' },
					addTags: ['Purchased'],
				},
			},
			'open-store': {
				openUrl: 'https://example.com/p',
			},
		},
	},
];
```

### 3.5 Complete Tier 1 Example: RSS Feed Watcher

Create a tiddler titled `$:/config/my-watchers/hn-rss.js` with the following fields:

- `type`: `application/javascript`
- `module-type`: `pwa-watcher`
- `watcher-id`: `demo.hn.rss`
- `schedule-cron`: `0 * * * *`
- `allowed-hosts`: `news.ycombinator.com`
- `enabled`: `yes`

```javascript
export async function evaluate(context, host) {
	const res = await host.fetch('https://news.ycombinator.com/rss');
	if (!res.ok || res.notModified || !res.body) return [];

	const feed = await host.parseXml(res.body);
	if (!feed || !feed.items || !feed.items.length) return [];

	const top = feed.items[0];
	const seenGuid = await host.getState('lastSeenGuid');
	if (seenGuid === top.guid) return [];

	await host.setState('lastSeenGuid', top.guid);

	const tiddlerTitle = 'HN: ' + top.title;
	return [
		{
			notify: {
				title: 'Top HN Story',
				body: top.title,
				tag: 'hn-top-story',
				openUrl: top.link, // Clicking the notification opens the external story URL
				actions: [
					{ action: 'open-tiddler', title: 'Open in Wiki' },
				],
			},
			createTiddler: {
				title: tiddlerTitle,
				text: 'Source: ' + top.link + '\n\n' + (top.description || ''),
				tags: ['HN', 'Clipped'],
				fields: {
					'source-url': top.link,
					'pub-date': top.pubDate || '',
				},
			},
			actionPatches: {
				'open-tiddler': {
					navigateTo: tiddlerTitle,
				},
			},
		},
	];
}
```

### 3.6 Testing & Debugging Watchers

- **Control Panel**: Open `$:/ControlPanel` → **TiddlyPWA** → **Push Notifications**. Under **Registered Server Watchers**, click **Run Now** next to any watcher to execute it immediately on the server (ignoring its cron schedule) and view `lastRunAt` or `lastError`.
- **Wikitext Button**: Trigger a watcher from anywhere in your wiki using `<$action-sendmessage>`:
  ```tid
  <$button>
    <$action-sendmessage $message="tm-pwa-run-watcher" watcher-id="demo.hn.rss"/>
    Run HN Watcher Now
  </$button>
  ```

---

## 4. Tier 2: Declarative Due-Date Rules (`$:/tags/NotificationRule`)

Tier 2 lets you schedule notifications purely declaratively from TiddlyWiki filters and date fields—without writing any JavaScript.

Whenever tiddlers matching a rule change, TiddlyPWA computes the firing timestamp on the client, encrypts the notification payload using your client-side `pushKey` (`AES-GCM-256`), and syncs the encrypted schedule to the server. **The server only knows _when_ to send the push, never the tiddler title or notification text.**

### 4.1 Notification Rule Tiddler Fields

Create a tiddler tagged `$:/tags/NotificationRule` with the following fields:

| Field            | Required | Description                                                                                                                                            |
| :--------------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags`           | **Yes**  | Must include `$:/tags/NotificationRule`.                                                                                                               |
| `rule-id`        | No       | Stable identifier for the rule (defaults to the rule tiddler's `title`).                                                                               |
| `filter`         | **Yes**  | TiddlyWiki filter selecting tiddlers to schedule (e.g., `[tag[Task]!tag[Done]has[due]]`).                                                              |
| `date-field`     | No       | Field on each matched tiddler containing the due date/time (defaults to `due`).                                                                        |
| `default-time`   | No       | Local time of day (`HH:mm`, 24-hour format) used when `date-field` contains a date-only value without a time component. Defaults to `09:00`.           |
| `offset-minutes` | No       | Integer minutes added to the parsed date/time (e.g., `-30` to notify 30 minutes before a deadline, or `0` for exact time). Defaults to `0`.            |
| `title-template` | No       | Notification title template. Supports `{{!!title}}` and `{{!!field}}` placeholders. Defaults to `{{!!title}}`.                                         |
| `body-template`  | No       | Notification body template. Supports `{{!!field}}` placeholders (e.g., `Due: {{!!due}}`).                                                              |
| `navigate-to`    | No       | Tiddler title template to open in TiddlyWiki when clicked (defaults to `{{!!title}}` unless `open-url`, `url-field`, or `click-action="none"` is set). |
| `url-field`      | No       | Field name on the matched tiddler containing an external URL to open when clicked (e.g., `url` or `source-url`).                                       |
| `open-url`       | No       | Explicit URL template (e.g., `{{!!url}}`) to open when the notification is clicked.                                                                    |
| `click-action`   | No       | `'navigate'` (default), `'url'`, or `'none'` (focus/open wiki without navigating).                                                                     |
| `actions-json`   | No       | Optional JSON array of notification action buttons (e.g., `[{"action":"complete","title":"Mark Done"}]`).                                              |
| `enabled`        | No       | Set to `no` or `false` to disable the rule. Defaults to `yes`.                                                                                         |

### 4.2 Supported Date Formats in `date-field`

TiddlyPWA automatically parses any of the following formats in your tiddler's `date-field`:

1. **TiddlyWiki 14- or 17-digit UTC timestamps**: `YYYYMMDDHHmmss` or `YYYYMMDDHHmmssSSS` (e.g., `20261025153000000`).
2. **Date-only strings** (interpreted in your local timezone at `default-time`, which defaults to `09:00`):
   - `YYYY-MM-DD` (e.g., `2026-10-25`)
   - `YYYYMMDD` (e.g., `20261025`)
3. **ISO 8601 date-time strings**: e.g., `2026-10-25T15:30:00` or `2026-10-25T21:30:00Z`.

### 4.3 Complete Tier 2 Example: Task Due Reminder Rule

1. Create a rule tiddler titled `$:/config/notification-rules/tasks-due`:
   - `tags`: `$:/tags/NotificationRule`
   - `rule-id`: `tasks-due`
   - `filter`: `[tag[Task]!tag[Done]has[due]]`
   - `date-field`: `due`
   - `default-time`: `09:00`
   - `offset-minutes`: `-15`
   - `title-template`: `Task Due Soon: {{!!title}}`
   - `body-template`: `{{!!caption}} (Due {{!!due}})`
2. Any tiddler tagged `Task` with a `due` field set in the future (within the next 30 days) is automatically encrypted and scheduled on the server. When you add the `Done` tag or delete the tiddler, the scheduled notification is automatically cancelled.

---

## 5. Tier 3: Ad-Hoc Widget Messages (`tm-pwa-schedule-notification`)

Tier 3 lets wikitext buttons, macros, or JavaScript modules schedule or cancel one-off notifications on the fly. Like Tier 2, Tier 3 payloads are encrypted client-side with `pushKey` before leaving the browser.

### 5.1 Scheduling a Notification (`tm-pwa-schedule-notification`)

Send `tm-pwa-schedule-notification` via `<$action-sendmessage>` or `$tw.rootWidget.dispatchEvent`:

| Parameter (Wikitext / JS)        | Required                            | Description                                                                                                                     |
| :------------------------------- | :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `id` / `schedule-id`             | **Yes**                             | Unique schedule identifier (e.g., `pomodoro-timer`). Re-using an `id` replaces any pending notification with the same ID.       |
| `delay-seconds` / `delaySeconds` | One of `delay-seconds` or `fire-at` | Number of seconds from now to fire the notification (e.g., `1500` for 25 minutes).                                              |
| `fire-at` / `fireAt`             | One of `delay-seconds` or `fire-at` | Exact firing time as epoch milliseconds, ISO timestamp, or TiddlyWiki 14/17-digit date string.                                  |
| `title`                          | **Yes**                             | Notification title text.                                                                                                        |
| `body`                           | No                                  | Notification body text.                                                                                                         |
| `navigate-to` / `navigateTo`     | No                                  | Tiddler title to open in TiddlyWiki when the notification is clicked.                                                           |
| `open-url` / `openUrl`           | No                                  | External URL to open when the notification is clicked.                                                                          |
| `click-action` / `clickAction`   | No                                  | `'navigate'`, `'url'`, or `'none'`.                                                                                             |
| `scope`                          | No                                  | `'device'` (default — sends only to the current browser/device) or `'all'` (broadcasts to all subscribed devices on this wiki). |
| `tag`                            | No                                  | Notification replacement tag (defaults to `id`).                                                                                |
| `actions`                        | No                                  | JSON string or array of `{ action, title }` buttons.                                                                            |
| `hook-data` / `hookData`         | No                                  | JSON string or object passed to `th-pwa-notification-action` hook handlers when clicked.                                        |

#### Wikitext Example

```tid
<$button>
  <$action-sendmessage
    $message="tm-pwa-schedule-notification"
    id="pomodoro-timer"
    delay-seconds="1500"
    title="Pomodoro Complete!"
    body="25 minutes elapsed — time for a 5 minute break."
    navigate-to="Pomodoro Tracker"
  />
  Start 25m Pomodoro
</$button>

<$button>
  <$action-sendmessage
    $message="tm-pwa-cancel-notification"
    id="pomodoro-timer"
  />
  Cancel Pomodoro
</$button>
```

#### JavaScript Example

```javascript
$tw.rootWidget.dispatchEvent({
	type: 'tm-pwa-schedule-notification',
	paramObject: {
		id: 'review-reminder:Note1',
		delaySeconds: '3600',
		title: 'Review Note1',
		body: 'Scheduled 1-hour spaced repetition check',
		navigateTo: 'Note1',
		scope: 'all',
		actions: JSON.stringify([
			{ action: 'snooze-1h', title: 'Snooze 1h' },
			{ action: 'mark-reviewed', title: 'Done' },
		]),
		hookData: JSON.stringify({ tiddler: 'Note1' }),
	},
});
```

### 5.2 Handling Notification Action Clicks in JavaScript (`th-pwa-notification-action`)

When a user clicks a notification or one of its action buttons, the service worker focuses/opens the wiki and dispatches the TiddlyWiki hook `th-pwa-notification-action`. Any plugin can register a hook handler to react:

```javascript
$tw.hooks.addHook('th-pwa-notification-action', function (event) {
	// event.action: string ('default' for main notification body click, or custom action ID)
	// event.tag: string
	// event.navigateTo: string | null
	// event.openUrl: string | null
	// event.clickAction: string | null
	// event.hookData: any
	if (event.action === 'mark-reviewed' && event.hookData?.tiddler) {
		const title = event.hookData.tiddler;
		const existing = $tw.wiki.getTiddler(title);
		if (existing) {
			$tw.wiki.addTiddler(new $tw.Tiddler(existing, { reviewed: 'yes' }, $tw.wiki.getModificationFields()));
		}
	}
});
```

---

## 6. Security & Cryptographic Architecture

1. **VAPID & RFC 8291 Web Push (`server/webpush.ts`)**:
   - On first start, the server generates an ECDSA P-256 VAPID keypair and stores it in SQLite (`server_config`).
   - All push payloads are encrypted per subscription using ECDH P-256 + HKDF-SHA-256 + AES-128-GCM (`aes128gcm` content encoding, RFC 8291).
   - Stale subscriptions (`404 Not Found` / `410 Gone` from push services) are pruned automatically.
2. **Client-Side Zero-Knowledge Encryption for Tiers 2 & 3**:
   - The client derives an `AES-GCM-256` `pushKey` from the master password via HKDF (`info: "push-payload"`).
   - `pushKey` is stored as a non-extractable `CryptoKey` in a scope-keyed IndexedDB (`tiddlypwa-push:<scopePathname>`) accessible to `sw.js`.
   - Tier 2 and Tier 3 notification titles, bodies, URLs, and actions are encrypted before leaving the client and decrypted inside `sw.js` upon receipt.
3. **Ed25519 Signed Watchers & Zero-Permission Deno Sandbox (`server/watcher_runner.ts`)**:
   - The client derives a deterministic Ed25519 signing keypair from the master key (`info: "watcher-ed25519"`).
   - Every `sync_watchers` request is verified against the wiki's pinned Ed25519 public key before storing or updating watcher code.
   - Watchers execute in a `new Worker(..., { deno: { permissions: "none" } })` isolate with no filesystem, environment, or direct network access.
   - `host.fetch()` validates every URL (and redirect hop) against `allowed-hosts` and resolves DNS via `Deno.resolveDns` to block loopback, link-local, RFC 1918 private networks, and cloud metadata IPs.
