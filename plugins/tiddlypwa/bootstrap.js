/*\
title: $:/plugins/mblackman/tiddlypwa/bootstrap.js
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

	const NOTEBOOK_ICON_SVG =
		`<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" aria-hidden="true">
			<path fill="#C49270" d="M427.932,4.041H134.917c-1.925-0.15-3.865-0.25-5.829-0.25c-40.814,0-73.901,33.086-73.901,73.9c0,1.986,0.08,3.952,0.234,5.898h-0.234v387.997c0,19.558,15.855,35.414,35.414,35.414h40.633v-81.18c3.453,1.059,7.118,1.631,10.918,1.631h297.662c20.544,0,37.199-16.654,37.199-37.199V53.121C477.013,26.015,455.039,4.041,427.932,4.041z"/>
			<path fill="#DCE2E2" d="M455.931,67.945c0-21.992-20.75-39.972-46.96-41.336v-0.093H129.088c-20.407,0-36.95,12.668-36.95,28.294s16.543,28.294,36.95,28.294v0.485H331.89v390.972l73.882,8.673c28.693,0,50.159-56.776,50.159-84.813V69.915h-0.06C455.908,69.262,455.931,68.606,455.931,67.945z"/>
			<path fill="#EDC0A2" d="M390.578,83.59H131.234V507h259.344c20.252,0,36.669-16.417,36.669-36.669V120.259C427.247,100.007,410.83,83.59,390.578,83.59z"/>
			<path fill="#F9F9F7" d="M333.49,240.399H200.546c-7.953,0-14.4-6.447-14.4-14.4v-50.115c0-7.953,6.447-14.4,14.4-14.4H333.49c7.953,0,14.4,6.447,14.4,14.4v50.115C347.89,233.952,341.443,240.399,333.49,240.399z"/>
		</svg>`;

	function getTimeGreeting() {
		const h = new Date().getHours();
		if (h < 5) return 'Working late';
		if (h < 12) return 'Good morning';
		if (h < 18) return 'Good afternoon';
		return 'Good evening';
	}

	function getCachedSplashData() {
		try {
			const raw = localStorage.getItem(`tiddlypwa-splash:${location.pathname}`);
			return raw ? JSON.parse(raw) : null;
		} catch (_e) {
			return null;
		}
	}

	module.exports.BootstrapModal = class {
		wrapper = dm('div', {
			class: 'tc-modal-wrapper tiddlypwa-modal-wrapper',
			style: { 'z-index': 4000 }, // below alerts, above hide-sidebar-btn and others (e.g. side panel in Notebook theme has z-index=3000)
		});
		modal = dm('div', { class: 'tc-modal tiddlypwa-modal' });
		modalBody = dm('div', { class: 'tc-modal-body tiddlypwa-modal-body' });
		bodyContent = dm('div', { class: 'tiddlypwa-modal-copy' });
		giveUpBtn = null;

		constructor() {
			this.wrapper.appendChild(dm('div', { class: 'tc-modal-backdrop' }));
			this.modalBody.appendChild(this.bodyContent);
			this.ensureSplash();
		}

		ensureSplash() {
			if (!document.body || document.getElementById('tiddlypwa-splash')) return;
			if (document.querySelector('.tc-page-container-wrapper')) return;
			try {
				const html = $tw.wiki.renderTiddler('text/plain', '$:/core/templates/raw-static-tiddler', {
					variables: { currentTiddler: '$:/plugins/mblackman/tiddlypwa/splash' },
				});
				if (html && html.trim()) {
					const tmp = document.createElement('div');
					tmp.innerHTML = html.trim();
					const splashEl = tmp.firstElementChild;
					if (splashEl) {
						document.body.insertBefore(splashEl, document.body.firstChild);
						this.applySplashPersonalization(splashEl);
					}
				}
			} catch (_e) {
				// Ignore if splash tiddler is unavailable
			}
		}

		applySplashPersonalization(targetEl) {
			if (!targetEl) return;
			const gEl = targetEl.querySelector('#tiddlypwa-splash-greeting');
			if (gEl) gEl.textContent = getTimeGreeting();
			const data = getCachedSplashData();
			if (!data) return;
			if (data.bg) targetEl.style.setProperty('--tpwa-bg', data.bg);
			if (data.surface) targetEl.style.setProperty('--tpwa-surface', data.surface);
			if (data.fg) targetEl.style.setProperty('--tpwa-fg', data.fg);
			if (data.muted) targetEl.style.setProperty('--tpwa-muted-raw', data.muted);
			if (data.accent) targetEl.style.setProperty('--tpwa-accent', data.accent);
			if (data.colorScheme) targetEl.style.setProperty('color-scheme', data.colorScheme);
			if (data.title) {
				const tEl = targetEl.querySelector('#tiddlypwa-splash-title');
				if (tEl) tEl.textContent = data.title;
			}
			if (data.subtitle) {
				const sEl = targetEl.querySelector('#tiddlypwa-splash-subtitle');
				if (sEl) sEl.textContent = data.subtitle;
			}
		}

		removeSplash() {
			const splashEl = document.getElementById('tiddlypwa-splash');
			if (splashEl && splashEl.parentNode) {
				splashEl.parentNode.removeChild(splashEl);
			}
		}

		showModal() {
			if (this.modalShown) return;
			this.modalShown = true;
			clearTimeout(this.modalTimeout);
			this.removeSplash();

			const cached = getCachedSplashData();
			this.applySplashPersonalization(this.wrapper);
			const wikiTitle = cached?.title && cached.title !== 'TiddlyPWA' ? cached.title : 'TiddlyPWA';

			const header = dm('div', { class: 'tc-modal-header tiddlypwa-modal-header' });
			const emblem = dm('div', { class: 'tiddlypwa-modal-emblem', innerHTML: NOTEBOOK_ICON_SVG });
			const greeting = dm('div', { class: 'tiddlypwa-modal-greeting', text: getTimeGreeting() });
			const heading = dm('h3', { text: `Welcome to ${wikiTitle}` });
			header.appendChild(emblem);
			header.appendChild(greeting);
			header.appendChild(heading);

			this.modal.appendChild(header);
			this.modal.appendChild(this.modalBody);
			this.wrapper.appendChild(this.modal);
			$tw.utils.addClass(document.body, 'tc-modal-prevent-scroll');
			document.body.appendChild(this.wrapper);

			if (this.giveUpBtn && !this.giveUpBtn.parentNode) {
				this.modalBody.appendChild(this.giveUpBtn);
			}
		}

		showModalDelayed(when) {
			this.modalTimeout = setTimeout(() => this.showModal(), when);
		}

		close() {
			clearTimeout(this.modalTimeout);
			this.abortGiveUpButton();
			if (this.wrapper.parentNode) {
				this.wrapper.parentNode.removeChild(this.wrapper);
			}
			$tw.utils.removeClass(document.body, 'tc-modal-prevent-scroll');
			if (document.querySelector('.tc-page-container-wrapper')) {
				this.removeSplash();
			} else {
				// Let render.js remove .tc-remove-when-wiki-loaded synchronously after mainRender,
				// with a fallback timer so it never lingers if render already ran.
				setTimeout(() => this.removeSplash(), 300);
			}
		}

		setBody(html) {
			this.bodyContent.innerHTML = html;
		}

		setProgress(percent, statusText) {
			const clamped = typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : null;
			const splashStatus = document.getElementById('tiddlypwa-splash-status');
			const splashPct = document.getElementById('tiddlypwa-splash-pct');
			const splashBar = document.getElementById('tiddlypwa-splash-bar');
			const splashProgress = document.getElementById('tiddlypwa-splash-progressbar');

			if (splashStatus && statusText) {
				splashStatus.textContent = statusText;
			}
			if (splashPct) {
				splashPct.textContent = clamped !== null ? `${clamped}%` : '';
			}
			if (splashBar) {
				if (clamped !== null) {
					splashBar.classList.remove('is-indeterminate');
					splashBar.style.inlineSize = `${clamped}%`;
					splashBar.style.width = `${clamped}%`;
					if (splashProgress) splashProgress.setAttribute('aria-valuenow', String(clamped));
				} else {
					splashBar.classList.add('is-indeterminate');
					splashBar.style.inlineSize = '';
					splashBar.style.width = '';
					if (splashProgress) splashProgress.removeAttribute('aria-valuenow');
				}
			}

			if (this.modalShown) {
				const pctHtml = clamped !== null ? `<span class="tiddlypwa-modal-progress-pct">${clamped}%</span>` : '';
				const barClass = clamped !== null ? 'tiddlypwa-splash-bar' : 'tiddlypwa-splash-bar is-indeterminate';
				const barStyle = clamped !== null ? `style="inline-size: ${clamped}%; width: ${clamped}%;"` : '';
				const label = statusText || 'Loading…';
				this.feedback.innerHTML = `
					<div class="tiddlypwa-modal-progress" role="status" aria-live="polite">
						<div class="tiddlypwa-modal-progress-row">
							<span class="tiddlypwa-splash-status-lead">
								<span class="tiddlypwa-splash-pulse" aria-hidden="true"></span>
								<span>${$tw.utils.htmlEncode(label)}</span>
							</span>
							${pctHtml}
						</div>
						<div class="tiddlypwa-splash-track">
							<div class="${barClass}" ${barStyle}></div>
						</div>
					</div>
				`;
			}
		}

		showGiveUpButtonDelayed(when, handlerFunction) {
			this.timeoutGiveUpBtn = setTimeout(() => {
				this.giveUpBtn = dm('button', {
					class: 'tiddlypwa-btn-secondary',
					text: 'Give up waiting',
					attributes: { type: 'button' },
					eventListeners: [{ name: 'click', handlerFunction }],
				});
				const splashActions = document.getElementById('tiddlypwa-splash-actions');
				if (!this.modalShown && splashActions) {
					splashActions.appendChild(this.giveUpBtn);
				} else {
					this.modalBody.appendChild(this.giveUpBtn);
				}
			}, when);
		}

		abortGiveUpButton() {
			clearTimeout(this.timeoutGiveUpBtn);
			if (this.giveUpBtn && this.giveUpBtn.parentNode) {
				this.giveUpBtn.parentNode.removeChild(this.giveUpBtn);
			}
			this.giveUpBtn = null;
		}

		form = dm('form', { class: 'tiddlypwa-form' });
		passLbl = dm('label', { innerHTML: 'Password' });
		passInput = dm('input', { attributes: { type: 'password', name: 'password', autocomplete: 'current-password' } });
		submit = dm('button', { class: 'tiddlypwa-btn-primary', attributes: { type: 'submit' }, text: 'Log in' });
		feedback = dm('div', {});

		biometricBox = null;
		showBiometricPrompt(onBiometricClick, onPasswordFallbackClick) {
			this.showModal();
			if (this.biometricBox) return;
			this.biometricBox = dm('div', { class: 'tiddlypwa-biometric-box' });
			this.biometricBox.innerHTML = `
				<div class="tiddlypwa-biometric-icon" aria-hidden="true">
					<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
				</div>
				<p style="margin: 0.35rem 0 0.2rem;"><strong>Unlock your wiki with biometrics</strong></p>
				<p style="margin: 0 0 0.85rem; font-size: 0.84rem; opacity: 0.8;">Touch ID, Face ID, or Windows Hello</p>
			`;
			const bioBtn = dm('button', {
				class: 'tiddlypwa-btn-primary',
				style: { 'margin-top': '0' },
				attributes: { type: 'button' },
				text: 'Unlock with Biometrics',
				eventListeners: [{ name: 'click', handlerFunction: onBiometricClick }],
			});
			const passBtn = dm('button', {
				class: 'tiddlypwa-btn-secondary',
				attributes: { type: 'button' },
				text: 'Enter Master Password instead',
				eventListeners: [{
					name: 'click',
					handlerFunction: () => {
						this.clearBiometricPrompt();
						if (onPasswordFallbackClick) onPasswordFallbackClick();
					},
				}],
			});
			this.biometricBox.appendChild(bioBtn);
			this.biometricBox.appendChild(passBtn);
			this.modalBody.insertBefore(this.biometricBox, this.bodyContent.nextSibling);
		}

		clearBiometricPrompt() {
			if (this.biometricBox && this.biometricBox.parentNode) {
				this.biometricBox.parentNode.removeChild(this.biometricBox);
				this.biometricBox = null;
			}
		}

		setPairedNotice(message) {
			const notice = dm('div', {
				class: 'tiddlypwa-paired-notice',
				innerHTML: message,
			});
			this.modalBody.insertBefore(notice, this.modalBody.firstChild);
		}

		setFeedback(html) {
			this.feedback.innerHTML = html;
			if (!this.modalShown && html) {
				const splashStatus = document.getElementById('tiddlypwa-splash-status');
				if (splashStatus) {
					const tmp = document.createElement('div');
					tmp.innerHTML = html;
					const plain = (tmp.textContent || '').trim();
					if (plain) splashStatus.textContent = plain;
				}
			}
		}

		setFresh() {
			this.passInput.setAttribute('autocomplete', 'new-password');
			this.submit.textContent = 'Create & Encrypt Wiki';
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

		addTokenInput(handlerFunction, initialValue, isPaired = false) {
			const tokLbl = dm('label', { text: isPaired ? 'Sync token (configured from pairing link)' : 'Sync token' });
			const input = dm('input', {
				attributes: { type: 'text', name: 'username', autocomplete: 'username' },
				eventListeners: [{ name: 'change', handlerFunction }, { name: 'input', handlerFunction }],
			});
			if (initialValue) {
				input.value = initialValue;
			}
			if (isPaired) {
				input.readOnly = true;
			}
			tokLbl.appendChild(input);
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
