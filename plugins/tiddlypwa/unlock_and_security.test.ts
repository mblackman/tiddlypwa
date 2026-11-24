// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';

const encodingSource = Deno.readTextFileSync('./plugins/tiddlypwa/encoding.js');
const bootstrapSource = Deno.readTextFileSync('./plugins/tiddlypwa/bootstrap.js');
const mainSource = Deno.readTextFileSync('./plugins/tiddlypwa/main.js');
const qrMacroSource = Deno.readTextFileSync('./plugins/tiddlypwa/macro-qrcode.js');
const argonSource = Deno.readTextFileSync('./plugins/tiddlypwa/argon2ian.js');

function createDomMock() {
	function makeEl(tag: string, opts: any = {}) {
		const listeners = new Map<string, Array<(evt: any) => any>>();
		const el: any = {
			tagName: tag.toUpperCase(),
			children: [] as any[],
			parentNode: null as any,
			style: { setProperty() {} },
			attributes: { ...(opts.attributes || {}) } as Record<string, string>,
			className: opts.class || '',
			innerHTML: opts.innerHTML || '',
			textContent: opts.text || '',
			value: '',
			type: opts.attributes?.type || '',
			name: opts.attributes?.name || '',
			id: opts.attributes?.id || '',
			disabled: false,
			readOnly: false,
			required: false,
			classList: {
				add() {},
				remove() {},
			},
			setAttribute(k: string, v: string) {
				this.attributes[k] = String(v);
				if (k === 'type') this.type = String(v);
				if (k === 'id') this.id = String(v);
				if (k === 'name') this.name = String(v);
			},
			getAttribute(k: string) {
				return this.attributes[k];
			},
			removeAttribute(k: string) {
				delete this.attributes[k];
			},
			appendChild(child: any) {
				child.parentNode = this;
				this.children.push(child);
				return child;
			},
			insertBefore(child: any, ref: any) {
				child.parentNode = this;
				const idx = ref ? this.children.indexOf(ref) : -1;
				if (idx >= 0) this.children.splice(idx, 0, child);
				else this.children.push(child);
				return child;
			},
			removeChild(child: any) {
				this.children = this.children.filter((c: any) => c !== child);
				child.parentNode = null;
			},
			addEventListener(name: string, fn: (evt: any) => any) {
				const arr = listeners.get(name) || [];
				arr.push(fn);
				listeners.set(name, arr);
			},
			dispatchEvent(evt: any) {
				if (!evt.target) evt.target = this;
				if (!evt.preventDefault) evt.preventDefault = () => {};
				for (const fn of listeners.get(evt.type) || []) fn(evt);
				if (evt.type === 'submit' && typeof this.onsubmit === 'function') this.onsubmit(evt);
				if (evt.type === 'click' && typeof this.onclick === 'function') this.onclick(evt);
			},
			focus() {},
			querySelector(sel: string): any {
				for (const c of this.children) {
					if (sel === 'input' && c.tagName === 'INPUT') return c;
					if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
					const nested = c.querySelector?.(sel);
					if (nested) return nested;
				}
				return null;
			},
			querySelectorAll(sel: string): any[] {
				const tags = sel.split(',').map((s) => s.trim().toUpperCase());
				const out: any[] = [];
				const walk = (n: any) => {
					for (const c of n.children || []) {
						if (tags.includes(c.tagName)) out.push(c);
						walk(c);
					}
				};
				walk(this);
				return out;
			},
		};
		for (const l of opts.eventListeners || []) {
			el.addEventListener(l.name, l.handlerFunction);
		}
		return el;
	}

	const doc: any = {
		body: makeEl('body'),
		createElement: (tag: string) => makeEl(tag),
		getElementById: () => null,
		querySelector: () => null,
		addEventListener() {},
	};
	return { doc, makeEl };
}

Deno.test('P1-9 & P2-4: BootstrapModal enforces password confirmation on fresh setup and blocks invalid salt on submit', async () => {
	const { doc, makeEl } = createDomMock();
	const $tw: any = {
		browser: true,
		utils: {
			domMaker: (tag: string, opts: any) => makeEl(tag, opts),
			addClass() {},
			removeClass() {},
			htmlEncode: (s: string) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
		},
		wiki: { renderTiddler: () => '' },
	};
	const bootMod: any = { exports: {} };
	const mockLoc = { pathname: '/w/app.html', origin: 'https://wiki.example.com' };
	new Function('$tw', 'module', 'document', 'location', bootstrapSource)($tw, bootMod, doc, mockLoc);

	const modal = new bootMod.exports.BootstrapModal();
	modal.setFresh();
	modal.addSaltInput(() => {});
	modal.showForm(false);

	// 1. Fresh form must include a confirmation password input and a Show/Hide password toggle
	const pwInputs = modal.form.querySelectorAll('input').filter((el: any) =>
		el.name === 'password' || el.name === 'new-password' || el.name === 'new-password-confirm' ||
		el.id?.includes('password')
	);
	assert(pwInputs.length >= 2, 'Fresh setup form must include password and confirmation password inputs');

	const toggleBtn = modal.form.querySelectorAll('button').find((b: any) =>
		String(b.getAttribute('aria-label') || b.textContent || '').toLowerCase().includes('password')
	);
	assert(toggleBtn, 'Form must include a show/hide password toggle button');

	// Toggle visibility works
	toggleBtn.dispatchEvent({ type: 'click' });
	assertEquals(modal.passInput.type, 'text');
	toggleBtn.dispatchEvent({ type: 'click' });
	assertEquals(modal.passInput.type, 'password');

	// 2. Mismatched passwords must NOT resolve formSubmitted
	let resolvedValue: string | null = null;
	const subPromise = modal.formSubmitted().then((v: string) => {
		resolvedValue = v;
	});
	modal.passInput.value = 'correct-horse-battery';
	modal.confirmInput.value = 'wrong-battery';
	modal.form.dispatchEvent({ type: 'submit' });
	await new Promise((r) => setTimeout(r, 10));
	assertEquals(resolvedValue, null, 'Mismatched confirm password must block submission');
	assert(modal.feedback.innerHTML.includes('match'), 'Mismatch must render feedback error');

	// 3. Non-empty invalid salt must block submission
	modal.confirmInput.value = 'correct-horse-battery';
	modal.setSaltValidator(() => 'The salt is too short');
	modal.saltInput.value = 'abc';
	modal.form.dispatchEvent({ type: 'submit' });
	await new Promise((r) => setTimeout(r, 10));
	assertEquals(resolvedValue, null, 'Invalid non-empty salt must block submission');

	// 4. Matching passwords + valid/empty salt resolves
	modal.saltInput.value = '';
	modal.setSaltValidator(() => '');
	modal.form.dispatchEvent({ type: 'submit' });
	await subPromise;
	assertEquals(resolvedValue, 'correct-horse-battery');
});

Deno.test('P1-8 & P3-3: macro-qrcode escapes errors and formatBytes(0) returns 0 bytes', () => {
	// QR macro error escaping
	const qrMod: any = { exports: {} };
	const mockTw: any = {
		browser: true,
		utils: {
			htmlEncode: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
		},
	};
	new Function('$tw', 'require', 'exports', qrMacroSource)(
		mockTw,
		() => ({
			generateQRCodeSvg: () => {
				throw new Error('<img src=x onerror=alert(1)>');
			},
		}),
		qrMod.exports,
	);
	const out = qrMod.exports.run('test');
	assertEquals(out.includes('<img'), false);
	assert(out.includes('&lt;img'));

	// formatBytes(0) and P0-2 / P1-8 checks inside main.js
	assert(mainSource.includes("if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 bytes'"));
	assert(mainSource.includes('verify_auth'));
	assert(mainSource.includes('$tw.utils.htmlEncode(endpoint'));
	assert(mainSource.includes('$tw.utils.htmlEncode(title)'));
});

Deno.test('P1-3: ArgonWorker rejects ready and pending hashes when Worker emits error', async () => {
	const origWorker = globalThis.Worker;
	const origCreate = URL.createObjectURL;
	const origRevoke = URL.revokeObjectURL;
	const revoked: string[] = [];
	let createdWorker: any = null;

	URL.createObjectURL = () => 'blob:mock-argon-worker';
	URL.revokeObjectURL = (u: string) => revoked.push(u);
	globalThis.Worker = class MockWorker {
		listeners = new Map<string, Array<(e: any) => void>>();
		onerror: any = null;
		constructor(_url: string) {
			createdWorker = this;
		}
		addEventListener(type: string, fn: (e: any) => void) {
			const arr = this.listeners.get(type) || [];
			arr.push(fn);
			this.listeners.set(type, arr);
		}
		postMessage() {}
		terminate() {}
		emitError(err: any) {
			for (const fn of this.listeners.get('error') || []) fn(err);
			if (this.onerror) this.onerror(err);
		}
	} as any;

	try {
		const mod: any = { exports: {} };
		new Function('$tw', 'module', argonSource)({ browser: true }, mod);
		const worker = new mod.exports.ArgonWorker();
		assertEquals(revoked, ['blob:mock-argon-worker']);
		createdWorker.emitError({ message: 'WASM compile blocked by CSP' });
		await assertRejects(() => worker.ready, Error, 'WASM');
	} finally {
		globalThis.Worker = origWorker;
		URL.createObjectURL = origCreate;
		URL.revokeObjectURL = origRevoke;
	}
});

Deno.test('Legacy supporter-key Control Panel tab and widget are removed', () => {
	assertThrows(() => Deno.statSync('./plugins/tiddlypwa/config-support.tid'), Deno.errors.NotFound);
	assertThrows(() => Deno.statSync('./plugins/tiddlypwa/supporter-key.js'), Deno.errors.NotFound);
	const styleCss = Deno.readTextFileSync('./plugins/tiddlypwa/style.css');
	assertEquals(styleCss.includes('.tiddlypwa-supporter'), false);
});
