/*\
title: $:/plugins/mblackman/tiddlypwa/supporter-key
type: application/javascript
module-type: widget

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser || !('crypto' in window)) return;

	const b64udec = (x) => {
		const b64 = x.replace(/_/g, '/').replace(/-/g, '+');
		const pad = b64.length % 4;
		const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
		return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	};

	const pubkey = crypto.subtle.importKey(
		'jwk',
		{
			'crv': 'P-256',
			'kid': 'xuf485BsGcWBWQF4GHvz32DM39Ls0zYLLTkczSBbdmw',
			'kty': 'EC',
			'use': 'sig',
			'x': 'HU_Qr8MJQdj58A7cDHXggO_-SGN-kaFc1kMnwH34vvM',
			'y': 'XMl52EulmwbzOoMmVWJEnZ6hw2UG4_xEixNUUU_TPwM',
		},
		{
			name: 'ECDSA',
			namedCurve: 'P-256',
		},
		true,
		['verify'],
	);

	const Widget = require('$:/core/modules/widgets/widget.js').widget;

	exports['tiddlypwa-supporter-key'] = class TSK extends Widget {
		#parent;
		render(parent, nextSibling) {
			this.computeAttributes();
			if (parent) this.#parent = parent;
			const node = this.document.createElement('p');
			this.#parent.insertBefore(node, nextSibling);
			this.domNodes.push(node);
			const key = this.getAttribute('key', '');
			if (key.length === 0) {
				node.innerText = '-key not found-';
				return;
			}
			const [prot, pl, sig] = key.trim().split('.');
			if (!prot || !pl || !sig) {
				node.innerText = '-key format not valid-';
				return;
			}
			node.innerText = '...';
			pubkey
				.then((k) =>
					crypto.subtle.verify(
						{ name: 'ECDSA', hash: { name: 'SHA-256' } },
						k,
						b64udec(sig),
						new TextEncoder().encode(prot + '.' + pl),
					)
				)
				.then((res) => {
					if (res) node.innerHTML = JSON.parse(new TextDecoder().decode(b64udec(pl))).h;
					else node.innerText = '-key signature not valid-';
				})
				.catch((e) => {
					console.error(e);
					node.innerText = '-key validation error-';
				});
		}

		refresh(_chg) {
			if (this.computeAttributes().key) {
				this.refreshSelf();
				return true;
			}
			return false;
		}
	};
})();
