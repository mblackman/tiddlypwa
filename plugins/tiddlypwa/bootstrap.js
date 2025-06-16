/*\
title: $:/plugins/valpackett/tiddlypwa/bootstrap.js
type: application/javascript
module-type: library

Licensed under 0BSD, see license.tid.
Formatted with `deno fmt`.
\*/
/// <reference types="npm:tw5-typed" />
(function () {
	'use strict';

	if (!$tw.browser) return;

	const dm = $tw.utils.domMaker;

	module.exports.BootstrapModal = class {
		wrapper = dm('div', { class: 'tc-modal-wrapper', style: { 'z-index': 4000 } }); // below alerts, above hide-sidebar-btn and others (e.g. side panel in Notebook theme has z-index=3000)
		constructor() {
			$tw.utils.addClass(document.body, 'tc-modal-prevent-scroll');
			this.wrapper.appendChild(dm('div', { class: 'tc-modal-backdrop' }));
			document.body.appendChild(this.wrapper);
		}

		modal = dm('div', { class: 'tc-modal' });
		modalBody = dm('div', { class: 'tc-modal-body' });
		showModal() {
			if (this.modalShown) return;
			this.modalShown = true;
			this.modal.appendChild(dm('div', { class: 'tc-modal-header', innerHTML: '<h3>Welcome to TiddlyPWA</h3>' }));
			this.modal.appendChild(this.modalBody);
			this.wrapper.appendChild(this.modal);
			clearTimeout(this.modalTimeout);
		}

		showModalDelayed(when) {
			this.modalTimeout = setTimeout(() => this.showModal(), when);
		}

		close() {
			clearTimeout(this.modalTimeout);
			document.body.removeChild(this.wrapper);
			$tw.utils.removeClass(document.body, 'tc-modal-prevent-scroll');
		}

		setBody(html) {
			this.modalBody.innerHTML = html;
		}

		showGiveUpButtonDelayed(when, handlerFunction) {
			this.timeoutGiveUpBtn = setTimeout(() =>
				this.modalBody.appendChild(dm('button', {
					text: 'Give up waiting',
					attributes: { type: 'button' },
					eventListeners: [{ name: 'click', handlerFunction }],
				})), when);
		}

		abortGiveUpButton() {
			clearTimeout(this.timeoutGiveUpBtn);
		}

		form = dm('form', { class: 'tiddlypwa-form' });
		passLbl = dm('label', { innerHTML: 'Password' });
		passInput = dm('input', { attributes: { type: 'password', name: 'password', autocomplete: 'current-password' } });
		submit = dm('button', { attributes: { type: 'submit' }, text: 'Log in' });
		feedback = dm('div', {});

		setFeedback(html) {
			this.feedback.innerHTML = html;
		}

		setFresh() {
			this.passInput.setAttribute('autocomplete', 'new-password');
		}

		showForm(empty) {
			if (this.formShown) return;
			this.formShown = true;
			this.showModal();
			if (!empty) {
				this.setInputsEnabled(false);
				this.passLbl.appendChild(this.passInput);
				this.form.appendChild(this.passLbl);
				this.form.appendChild(this.submit);
			}
			this.form.appendChild(this.feedback);
			this.modalBody.appendChild(this.form);
		}

		showFormDelayed(when, empty) {
			this.modalTimeout = setTimeout(() => this.showForm(empty), when);
		}

		setInputsEnabled(enabled) {
			for (const el of this.form.querySelectorAll('input,button')) el.disabled = !enabled;
		}

		formSubmitted() {
			this.setInputsEnabled(true);
			this.form.querySelector('input')?.focus();
			return new Promise((resolve) => {
				this.form.onsubmit = (e) => {
					e.preventDefault();
					this.setInputsEnabled(false);
					resolve(this.passInput.value);
				};
			});
		}

		addTokenInput(handlerFunction) {
			const tokLbl = dm('label', { text: 'Sync token' });
			tokLbl.appendChild(dm('input', {
				attributes: { type: 'text', name: 'username', autocomplete: 'username' },
				eventListeners: [{ name: 'change', handlerFunction }],
			}));
			this.form.appendChild(tokLbl);
		}

		addSaltInput(handlerFunction) {
			const saltDtl = dm('details', {
				innerHTML: `
					<summary>If you are going to sync a pre-existing wiki into this one, click here</summary>
					<p>In order for such a sync to succeed, the wiki needs to be initialized with the same "salt" as well as the same password.</p>
					<p>Copy the salt from the <strong>Settings</strong> → <strong>Storage and Sync</strong> page on the existing wiki, or from the sync admin interface.</p>
				`,
			});
			const saltLbl = dm('label', { text: 'Salt' });
			saltLbl.appendChild(dm('input', {
				attributes: { type: 'text', name: 'salt', autocomplete: 'off' },
				eventListeners: [{ name: 'change', handlerFunction }],
			}));
			saltDtl.appendChild(saltLbl);
			this.form.appendChild(saltDtl);
		}
	};
})();
