import { Datastore } from './data.d.ts';
import { broadcastWikiPush, VapidKeys } from './webpush.ts';
import { TiddlyPWASyncApp } from './app.ts';
import {
	computeCodeHash,
	DnsResolverFn,
	executeWatcherModule,
	verifyWatcherSignature,
	WatchedItem,
} from './watcher_runner.ts';

export type SchedulerTickOptions = {
	nowMs?: number;
	subject?: string;
	fetchFn?: typeof fetch;
	watcherFetchFn?: typeof fetch;
	resolveDnsFn?: DnsResolverFn;
	watcherTimeoutMs?: number;
};

export type SchedulerTickResult = {
	processed: number;
	sent: number;
	failed: number;
	pruned: number;
};

export type WatcherTickResult = {
	evaluated: number;
	succeeded: number;
	failed: number;
	notificationsSent: number;
	patchesStaged: number;
};

const WEEKDAY_MAP: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

function matchCronField(fieldExpr: string, value: number, min: number, max: number, isDayOfWeek = false): boolean {
	const parts = fieldExpr.split(',');
	for (const rawPart of parts) {
		const part = rawPart.trim();
		if (!part) continue;
		const [rangePart, stepStr] = part.split('/');
		const step = stepStr !== undefined ? Number(stepStr) : 1;
		if (!Number.isInteger(step) || step <= 0) return false;

		let rangeStart = min;
		let rangeEnd = max;
		if (rangePart !== '*') {
			if (rangePart.includes('-')) {
				const [sStr, eStr] = rangePart.split('-');
				rangeStart = Number(sStr);
				rangeEnd = Number(eStr);
				if (isDayOfWeek && rangeEnd === 7 && rangeStart === 0) {
					rangeEnd = 7;
				}
			} else {
				const exact = Number(rangePart);
				if (!Number.isInteger(exact)) return false;
				const normalizedExact = isDayOfWeek && exact === 7 ? 0 : exact;
				if (stepStr === undefined) {
					if (value === normalizedExact) return true;
					continue;
				}
				rangeStart = normalizedExact;
				rangeEnd = max;
			}
		}

		if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < min || rangeEnd > max) {
			return false;
		}
		const checkVal = isDayOfWeek && value === 0 && rangeEnd === 7 && rangeStart > 0 ? 7 : value;
		if (checkVal >= rangeStart && checkVal <= rangeEnd && (checkVal - rangeStart) % step === 0) {
			return true;
		}
	}
	return false;
}

export function matchesCron(cronExpr: string, dateMs: number, timezone = 'UTC'): boolean {
	if (typeof cronExpr !== 'string') return false;
	const fields = cronExpr.trim().split(/\s+/);
	if (fields.length !== 5) return false;

	let tz = timezone || 'UTC';
	let dtf: Intl.DateTimeFormat;
	try {
		dtf = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			weekday: 'short',
			hourCycle: 'h23',
		});
	} catch (_e) {
		tz = 'UTC';
		dtf = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			weekday: 'short',
			hourCycle: 'h23',
		});
	}

	const parts = dtf.formatToParts(new Date(dateMs));
	let minute = -1;
	let hour = -1;
	let day = -1;
	let month = -1;
	let dayOfWeek = -1;

	for (const p of parts) {
		if (p.type === 'minute') minute = Number(p.value);
		else if (p.type === 'hour') {
			hour = Number(p.value);
			if (hour === 24) hour = 0;
		} else if (p.type === 'day') day = Number(p.value);
		else if (p.type === 'month') month = Number(p.value);
		else if (p.type === 'weekday') {
			const w = WEEKDAY_MAP[p.value.slice(0, 3).toLowerCase()];
			if (w !== undefined) dayOfWeek = w;
		}
	}

	if (minute < 0 || hour < 0 || day < 1 || month < 1 || dayOfWeek < 0) return false;

	if (!matchCronField(fields[0], minute, 0, 59)) return false;
	if (!matchCronField(fields[1], hour, 0, 23)) return false;
	if (!matchCronField(fields[2], day, 1, 31)) return false;
	if (!matchCronField(fields[3], month, 1, 12)) return false;
	if (!matchCronField(fields[4], dayOfWeek, 0, 7, true)) return false;

	return true;
}

export async function tickScheduledNotifications(
	db: Datastore,
	vapidKeys: VapidKeys,
	options?: SchedulerTickOptions,
): Promise<SchedulerTickResult> {
	const nowMs = options?.nowMs ?? Date.now();
	const dueRows = db.listDueScheduledNotifications(nowMs);
	let processed = 0;
	let sent = 0;
	let failed = 0;
	let pruned = 0;

	for (const row of dueRows) {
		processed++;
		let payload: Record<string, unknown> | null = null;
		try {
			const parsed = JSON.parse(row.payload_json);
			if (parsed && typeof parsed === 'object') {
				payload = parsed as Record<string, unknown>;
			}
		} catch (_e) {
			payload = null;
		}
		if (payload) {
			try {
				const res = await broadcastWikiPush(db, row.token, payload, vapidKeys, {
					targetEndpoint: row.target_endpoint ?? null,
					subject: options?.subject,
					fetchFn: options?.fetchFn,
				});
				sent += res.sent;
				failed += res.failed;
				pruned += res.pruned;
			} catch (e) {
				console.error('Error dispatching scheduled push notification:', e);
				failed++;
			}
		}
		db.deleteScheduledNotifications(row.token, [row.schedule_id]);
	}

	return { processed, sent, failed, pruned };
}

export async function tickWatchers(
	db: Datastore,
	vapidKeys: VapidKeys,
	options?: SchedulerTickOptions,
): Promise<WatcherTickResult> {
	const nowMs = options?.nowMs ?? Date.now();
	const currentMinuteBucket = Math.floor(nowMs / 60_000);
	const allWatchers = db.getAllWatcherModules();

	let evaluated = 0;
	let succeeded = 0;
	let failed = 0;
	let notificationsSent = 0;
	let patchesStaged = 0;

	for (const row of allWatchers) {
		const lastMinuteBucket = Math.floor((row.last_run_at || 0) / 60_000);
		if (currentMinuteBucket <= lastMinuteBucket) continue;
		if (!matchesCron(row.schedule_cron, nowMs, row.timezone || 'UTC')) continue;

		evaluated++;
		const wiki = db.getWiki(row.token);
		if (!wiki || !wiki.watcher_pubkey) {
			db.updateWatcherRunState(
				row.token,
				row.watcher_id,
				row.state_json || '{}',
				nowMs,
				'Missing wiki watcher public key',
			);
			failed++;
			continue;
		}

		const actualHash = await computeCodeHash(row.code_source);
		if (actualHash !== row.code_hash) {
			db.updateWatcherRunState(
				row.token,
				row.watcher_id,
				row.state_json || '{}',
				nowMs,
				'Watcher code hash mismatch',
			);
			failed++;
			continue;
		}

		let watchedItems: WatchedItem[] = [];
		try {
			const parsed = JSON.parse(row.watched_items || '[]');
			if (Array.isArray(parsed)) watchedItems = parsed;
		} catch (_e) {
			watchedItems = [];
		}

		const sigValid = await verifyWatcherSignature(
			wiki.watcher_pubkey,
			{
				watcherId: row.watcher_id,
				codeHash: row.code_hash,
				allowedHosts: row.allowed_hosts,
				scheduleCron: row.schedule_cron,
				timezone: row.timezone || 'UTC',
				watchedItems,
			},
			row.signature,
		);
		if (!sigValid) {
			db.updateWatcherRunState(
				row.token,
				row.watcher_id,
				row.state_json || '{}',
				nowMs,
				'Ed25519 signature verification failed',
			);
			failed++;
			continue;
		}

		const summary = await executeWatcherModule(db, row, vapidKeys, {
			nowMs,
			subject: options?.subject,
			fetchFn: options?.watcherFetchFn ?? options?.fetchFn,
			pushFetchFn: options?.fetchFn,
			resolveDnsFn: options?.resolveDnsFn,
			timeoutMs: options?.watcherTimeoutMs,
		});
		if (summary.ok) {
			succeeded++;
			notificationsSent += summary.notificationsSent;
			patchesStaged += summary.patchesStaged;
		} else {
			failed++;
		}
	}

	return { evaluated, succeeded, failed, notificationsSent, patchesStaged };
}

export function startSchedulerLoop(app: TiddlyPWASyncApp, intervalMs = 30_000): { stop: () => void } {
	let running = false;
	const timer = setInterval(async () => {
		if (running) return;
		running = true;
		try {
			const vapid = await app.ensureVapidKeys();
			await tickScheduledNotifications(app.db, vapid, {
				subject: app.vapidSubject,
				fetchFn: app.pushFetchFn,
			});
			await tickWatchers(app.db, vapid, {
				subject: app.vapidSubject,
				fetchFn: app.pushFetchFn,
				watcherFetchFn: app.watcherFetchFn,
				resolveDnsFn: app.resolveDnsFn,
			});
		} catch (e) {
			console.error('Scheduler loop error:', e);
		} finally {
			running = false;
		}
	}, intervalMs);

	return {
		stop() {
			clearInterval(timer);
		},
	};
}
