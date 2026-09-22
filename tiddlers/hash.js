/*\
title: $:/hash.js
tags: [[TiddlyPWA Docs]]
type: application/javascript
module-type: widget

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const safe = { '+': '-', '/': '_' };
	const b64uenc = (bytes) =>
		btoa(Array.from(bytes, (x) => String.fromCodePoint(x)).join(''))
			.replace(/[+/]/g, (m) => safe[m]).replace(/[.=]{1,2}$/, '');
	const Widget = require('$:/core/modules/widgets/widget.js').widget;

	let worker;

	exports['admin-password-hash'] = class HW extends Widget {
		#parent;
		render(parent, nextSibling) {
			this.computeAttributes();
			if (parent) this.#parent = parent;
			const glitch = this.hasAttribute('glitch');
			const node = this.document.createElement(glitch ? 'a' : 'pre');
			node.hidden = true;
			this.#parent.insertBefore(node, nextSibling);
			this.domNodes.push(node);
			if (glitch) {
				const img = this.document.createElement('img');
				img.alt = 'Remix on Glitch!';
				img.src = 'https://cdn.glitch.com/2703baf2-b643-4da7-ab91-7ee2a2d00b5b%2Fremix-button-v2.svg';
				node.appendChild(img);
				node.target = '_blank';
			}
			if (!worker) {
				const AW = require('$:/plugins/mblackman/tiddlypwa/argon2ian.js').ArgonWorker;
				worker = new AW();
			}
			const password = this.getAttribute('password', '');
			if (password.length > 0) {
				const salt = crypto.getRandomValues(new Uint8Array(32));
				worker.ready.then(() => worker.hash(new TextEncoder().encode(password), salt)).then((hash) => {
					const ph = 'ADMIN_PASSWORD_HASH=' + b64uenc(hash);
					const ps = 'ADMIN_PASSWORD_SALT=' + b64uenc(salt);
					if (glitch) {
						node.href = `https://glitch.com/edit/#!/remix/tiddlypwa-sync-server?${ph}&${ps}`;
					} else {
						node.textContent = ph + '\n' + ps;
					}
					node.hidden = false;
				});
			} else node.hidden = true;
		}
		refresh(_chg) {
			if (this.computeAttributes().password) {
				this.refreshSelf();
				return true;
			}
			return false;
		}
	};
})();
