const html = String.raw; // For tools/editors

export const homePage = html`
	<!doctype html>
	<html lang=en>
		<head>
			<meta charset=utf-8>
			<title>TiddlyPWA Sync Server Control Panel</title>
			<style>
				* { box-sizing: border-box; }
				html { background: #252525; color: #fbfbfb; -webkit-text-size-adjust: none; text-size-adjust: none; accent-color: limegreen; }
				body { margin: 2rem auto; min-width: 300px; max-width: 120ch; line-height: 1.5; word-wrap: break-word; font-family: system-ui, sans-serif; }
				a { color: limegreen; }
				a:hover { color: lime; }
				h1 { font: 1.25rem monospace; text-align: center; color: limegreen; margin-bottom: 2rem; }
				h2 { font-size: 1.15rem; margin: 1rem 0; }
				fieldset { border: none; text-align: center; }
				thead { font-weight: bolder; background: rgba(0,240,0,.1); }
				footer { text-align: center; margin-top: 2rem; }
				table { border-collapse: collapse; margin: 1rem 0; }
				td { padding: 0.25rem 0.6rem; }
				tr:nth-child(even) { background: rgba(255,255,255,.08); }
				#wikirows td:nth-of-type(2), #wikirows td:nth-of-type(3) { font-family: monospace; }
			</style>
		</head>
		<body>
			<h1>TiddlyPWA Sync Server Control Panel</h1>
			<noscript>Enable JavaScript!</noscript>
			<form id=login>
				<fieldset>
					<input type=password id=atoken>
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
				<button id=refresh>Refresh</button>
				<button id=create>Create new wiki</button>
				<button id=upgradeall>Upgrade All to Default</button>
				<h2>Endpoint URL</h2>
				<p>This is what should be pasted into the TiddlyPWA sync settings or the app uploader:<br><code id=endpoint></code></p>
			</div>
			<footer>
				<a href=https://github.com/mblackman/tiddlypwa>TiddlyPWA</a> sync server ✦ maintained by <a href=https://github.com/mblackman>Matt Blackman</a> (originally by <a href=https://val.packett.cool/>Val Packett</a>)
			</footer>
			<script>
				const knownErrors = {
					EAUTH: 'Wrong token',
				};
				function formatBytes(bytes) {
					const sizes = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
					const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
					if (i >= sizes.length) return 'too much';
					return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
				}
				async function serverReq(data) {
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
						alert(await resp.json().then(({ error }) => knownErrors[error] || error).catch((_e) =>
							'Server returned error ' + resp.status
						));
						return false;
					}
					return resp;
				}
				async function refreshTokens() {
					const resp = await serverReq({ op: 'list' });
					if (!resp) return false;
					const { wikis } = await resp.json();
					const wikirows = document.getElementById('wikirows')
					wikirows.replaceChildren();
					for (const { token, note, salt, tidsize, appsize } of wikis) {
						const tr = document.createElement('tr');
						const noteTd = document.createElement('td');
						noteTd.innerText = note ?? '-';
						tr.appendChild(noteTd);
						const tokenTd = document.createElement('td');
						tokenTd.innerText = token;
						tr.appendChild(tokenTd);
						const saltTd = document.createElement('td');
						saltTd.innerText = salt ?? '-';
						tr.appendChild(saltTd);
						const tidsizeTd = document.createElement('td');
						tidsizeTd.innerText = tidsize > 0 ? formatBytes(tidsize) : '-';
						tr.appendChild(tidsizeTd);
						const appsizeTd = document.createElement('td');
						const appsizeA = document.createElement('a');
						appsizeA.href = new URL(token.slice(0, token.length / 2) + '/app.html', document.location).toString();
						if (appsize > 0) {
							appsizeA.innerText = formatBytes(appsize) + ' (custom)';
						} else {
							appsizeA.innerText = 'v5.4.1 (default)';
						}
						appsizeTd.appendChild(appsizeA);
						tr.appendChild(appsizeTd);
						const btnsTd = document.createElement('td');
						const btnReauth = document.createElement('button');
						btnReauth.innerText = 'Clear Auth';
						btnReauth.onclick = (e) => {
							if (!confirm('Do you really want to clear authentication checks for the wiki with token ' + token + '?')) return;
							serverReq({ op: 'reauth', token }).then(() => document.getElementById('refresh').click());
						};
						btnsTd.appendChild(btnReauth);
						const btnDel = document.createElement('button');
						btnDel.innerText = 'Delete';
						btnDel.onclick = (e) => {
							if (!confirm('Do you really want to delete the wiki with token ' + token + '?')) return;
							serverReq({ op: 'delete', token }).then(() => document.getElementById('refresh').click());
						};
						btnsTd.appendChild(btnDel);
						if (appsize > 0) {
							const btnReset = document.createElement('button');
							btnReset.innerText = 'Reset App';
							btnReset.onclick = (e) => {
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
							alert('Unexpected error!');
							loginForm.querySelector('fieldset').disabled = false;
						});
					};
					const refreshBtn = document.getElementById('refresh');
					const createBtn = document.getElementById('create');
					refreshBtn.onclick = () => {
						refreshBtn.disabled = createBtn.disabled = true;
						refreshTokens().then(() => {
							refreshBtn.disabled = createBtn.disabled = false;
						}).catch((e) => {
							console.error(e);
							alert('Unexpected error!');
							refreshBtn.disabled = createBtn.disabled = false;
						});
					};
					createBtn.onclick = () => {
						serverReq({ op: 'create', note: prompt('Leave a note about this wiki if you want?') || '' }).then(() => refreshBtn.click());
					}
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
