/*\
title: $:/plugins/mblackman/tiddlypwa/macro-qrcode.js
type: application/javascript
module-type: macro

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const { generateQRCodeSvg } = require('$:/plugins/mblackman/tiddlypwa/qrcode.js');

	exports.name = 'tiddlypwa-qrcode';
	exports.params = [
		{ name: 'text' },
		{ name: 'margin', default: '4' },
		{ name: 'ecLevel', default: 'M' },
	];

	exports.run = function (text, margin, ecLevel) {
		if (!text) return '';
		try {
			return generateQRCodeSvg(text, {
				margin: parseInt(margin, 10) || 4,
				ecLevel: ecLevel || 'M',
			});
		} catch (e) {
			return '<div class="tc-error">Failed to generate QR code: ' + e.message + '</div>';
		}
	};
})();
