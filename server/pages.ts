const html = String.raw; // For tools/editors

export function renderHomePage(defaultVersion = '5.4.1'): string {
	const safeVersion = String(defaultVersion || '5.4.1').replace(/[^0-9A-Za-z._-]/g, '') || '5.4.1';
	return html`
		<!doctype html>
		<html lang=en>
			<head>
				<meta charset=utf-8>
				<meta name="viewport" content="width=device-width, initial-scale=1">
				<meta name="color-scheme" content="light dark">
				<title>TiddlyPWA Sync Server Control Panel</title>
				<style>
					* { box-sizing: border-box; }
					html { background: #252525; color: #fbfbfb; -webkit-text-size-adjust: none; text-size-adjust: none; accent-color: limegreen; }
					body { margin: 2rem auto; padding: 0 1rem; min-width: 300px; max-width: 120ch; line-height: 1.5; word-wrap: break-word; font-family: system-ui, sans-serif; }
					a { color: limegreen; }
					a:hover { color: lime; }
					h1 { font: 1.25rem monospace; text-align: center; color: limegreen; margin-bottom: 2rem; }
					h2 { font-size: 1.15rem; margin: 1rem 0; }
					fieldset { border: none; text-align: center; }
					thead { font-weight: bolder; background: rgba(0,240,0,.1); }
					footer { text-align: center; margin-top: 2rem; }
					table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
					td { padding: 0.25rem 0.6rem; }
					tr:nth-child(even) { background: rgba(255,255,255,.08); }
					#wikirows td:nth-of-type(2), #wikirows td:nth-of-type(3) { font-family: monospace; }
					#createform { margin: 0.75rem 0; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
					#createform[hidden] { display: none; }
					#statusmsg { min-height: 1.4em; color: #ff8c7a; }
				</style>
			</head>
			<body>
				<h1>TiddlyPWA Sync Server Control Panel</h1>
				<noscript>Enable JavaScript!</noscript>
				<p id=statusmsg role=status aria-live=polite></p>
				<form id=login>
					<fieldset>
						<label for=atoken>Admin token:</label>
						<input type=password id=atoken autocomplete=current-password required>
						<button>Log in</button>
					</fieldset>
				</form>
				<div id=loggedin hidden>
					<h2>Wikis on the server:</h2>
					<table>
						<thead>
							<tr>
								<td>Note</td>
								<td>Token</td>
								<td>Salt</td>
								<td>Content Size</td>
								<td>App Files Size</td>
								<td></td>
							</tr>
						</thead>
						<tbody id=wikirows></tbody>
					</table>
					<button id=refresh type=button>Refresh</button>
					<button id=create type=button>Create new wiki</button>
					<button id=upgradeall type=button>Upgrade All to Default</button>
					<form id=createform hidden>
						<label for=newnote>Wiki note (optional):</label>
						<input id=newnote type=text autocomplete=off placeholder="e.g. Personal Notes">
						<button type=submit>Create Wiki</button>
						<button id=createcancel type=button>Cancel</button>
					</form>
					<h2>Endpoint URL</h2>
					<p>This is what should be pasted into the TiddlyPWA sync settings or the app uploader:<br><code id=endpoint></code></p>
				</div>
				<footer>
					<a href=https://github.com/mblackman/tiddlypwa>TiddlyPWA</a> sync server - maintained by <a href=https://github.com/mblackman>Matt Blackman</a> (originally by <a href=https://val.packett.cool/>Val Packett</a>)
				</footer>
				<script>
					const defaultAppLabel = 'v${safeVersion} (default)';
					const knownErrors = {
						EAUTH: 'Wrong token',
						ERATELIMIT: 'Too many failed attempts, please wait and try again',
					};
					function setStatus(msg) {
						const el = document.getElementById('statusmsg');
						if (el) el.textContent = msg || '';
					}
					function formatBytes(bytes) {
						if (!bytes) return '0 B';
						const sizes = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
						const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
						if (i >= sizes.length) return 'too much';
						return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
					}
					function wikiLaunchUrl(token) {
						return new URL(token.slice(0, token.length / 2) + '/app.html#token=' + token, document.location).toString();
					}
					async function serverReq(data) {
						setStatus('');
						const resp = await fetch('tid.dly', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								tiddlypwa: 1,
								atoken: document.getElementById('atoken').value,
								...data,
							}),
						});
						if (!resp.ok) {
							const msg = await resp.json().then(({ error }) => knownErrors[error] || error).catch((_e) =>
								'Server returned error ' + resp.status
							);
							setStatus(msg);
							return false;
						}
						return resp;
					}
					async function refreshTokens() {
						const resp = await serverReq({ op: 'list' });
						if (!resp) return false;
						const { wikis } = await resp.json();
						const wikirows = document.getElementById('wikirows');
						wikirows.replaceChildren();
						for (const { token, note, salt, tidsize, appsize } of wikis) {
							const tr = document.createElement('tr');
							const noteTd = document.createElement('td');
							noteTd.innerText = note ?? '-';
							tr.appendChild(noteTd);
							const tokenTd = document.createElement('td');
							tokenTd.innerText = token;
							tokenTd.style.cursor = 'pointer';
							tokenTd.title = 'Click to copy token';
							tokenTd.onclick = () => {
								navigator.clipboard.writeText(token);
								const orig = tokenTd.innerText;
								tokenTd.innerText = 'Copied!';
								setTimeout(() => tokenTd.innerText = orig, 1200);
							};
							tr.appendChild(tokenTd);
							const saltTd = document.createElement('td');
							saltTd.innerText = salt ?? '-';
							tr.appendChild(saltTd);
							const tidsizeTd = document.createElement('td');
							tidsizeTd.innerText = tidsize > 0 ? formatBytes(tidsize) : '-';
							tr.appendChild(tidsizeTd);
							const appsizeTd = document.createElement('td');
							const appsizeA = document.createElement('a');
							appsizeA.href = wikiLaunchUrl(token);
							appsizeA.target = '_blank';
							appsizeA.rel = 'noopener noreferrer';
							if (appsize > 0) {
								appsizeA.innerText = formatBytes(appsize) + ' (custom)';
							} else {
								appsizeA.innerText = defaultAppLabel;
							}
							appsizeTd.appendChild(appsizeA);
							tr.appendChild(appsizeTd);
							const btnsTd = document.createElement('td');
							const btnOpen = document.createElement('button');
							btnOpen.innerText = 'Open App';
							btnOpen.onclick = () => {
								window.open(wikiLaunchUrl(token), '_blank', 'noopener,noreferrer');
							};
							btnsTd.appendChild(btnOpen);
							const btnReauth = document.createElement('button');
							btnReauth.innerText = 'Clear Auth';
							btnReauth.onclick = () => {
								if (!confirm('Do you really want to clear authentication checks for the wiki with token ' + token + '?')) return;
								serverReq({ op: 'reauth', token }).then(() => document.getElementById('refresh').click());
							};
							btnsTd.appendChild(btnReauth);
							const btnDel = document.createElement('button');
							btnDel.innerText = 'Delete';
							btnDel.onclick = () => {
								if (!confirm('Do you really want to delete the wiki with token ' + token + '?')) return;
								serverReq({ op: 'delete', token }).then(() => document.getElementById('refresh').click());
							};
							btnsTd.appendChild(btnDel);
							if (appsize > 0) {
								const btnReset = document.createElement('button');
								btnReset.innerText = 'Reset App';
								btnReset.onclick = () => {
									if (!confirm('Reset wiki app to server default? Custom app files will be removed.')) return;
									serverReq({ op: 'resetapp', token }).then(() => document.getElementById('refresh').click());
								};
								btnsTd.appendChild(btnReset);
							}
							tr.appendChild(btnsTd);
							wikirows.appendChild(tr);
						}
						return true;
					}
					window.addEventListener('DOMContentLoaded', (_) => {
						const loginForm = document.getElementById('login');
						loginForm.onsubmit = (e) => {
							e.preventDefault();
							loginForm.querySelector('fieldset').disabled = true;
							refreshTokens().then((suc) => {
								document.getElementById('endpoint').textContent = new URL('tid.dly', document.location).toString();
								document.getElementById('loggedin').hidden = !suc;
								loginForm.hidden = suc;
								loginForm.querySelector('fieldset').disabled = suc;
							}).catch((e) => {
								console.error(e);
								setStatus('Unexpected error!');
								loginForm.querySelector('fieldset').disabled = false;
							});
						};
						const refreshBtn = document.getElementById('refresh');
						const createBtn = document.getElementById('create');
						const createForm = document.getElementById('createform');
						const newNoteInput = document.getElementById('newnote');
						const createCancel = document.getElementById('createcancel');
						refreshBtn.onclick = () => {
							refreshBtn.disabled = createBtn.disabled = true;
							refreshTokens().then(() => {
								refreshBtn.disabled = createBtn.disabled = false;
							}).catch((e) => {
								console.error(e);
								setStatus('Unexpected error!');
								refreshBtn.disabled = createBtn.disabled = false;
							});
						};
						createBtn.onclick = () => {
							createForm.hidden = false;
							newNoteInput.focus();
						};
						createCancel.onclick = () => {
							newNoteInput.value = '';
							createForm.hidden = true;
						};
						createForm.onsubmit = (e) => {
							e.preventDefault();
							const note = newNoteInput.value;
							newNoteInput.value = '';
							createForm.hidden = true;
							serverReq({ op: 'create', note }).then(async (resp) => {
								if (resp) {
									refreshBtn.click();
									const data = await resp.json();
									if (data && data.token) {
										window.open(wikiLaunchUrl(data.token), '_blank', 'noopener,noreferrer');
									}
								}
							});
						};
						const upgradeAllBtn = document.getElementById('upgradeall');
						upgradeAllBtn.onclick = () => {
							if (!confirm('Upgrade all wikis to the server default app? This will remove any custom app uploads.')) return;
							serverReq({ op: 'resetallapps' }).then(() => refreshBtn.click());
						};
					});
				</script>
			</body>
		</html>
	`;
}

export const homePage = renderHomePage('5.4.1');
