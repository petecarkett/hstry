import { DEFAULT_PROVIDER_SETTINGS, badgeState, friendlyError, formatTime, normalizeSettings, progressDetail, providerState } from '../ui.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) { console.log(`  got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failures++; }
}

const now = Date.parse('2026-07-10T12:00:00Z');
check('new providers are opt-in', DEFAULT_PROVIDER_SETTINGS, {
  chatgpt: true,
});
check('never synced time', formatTime(null, now), 'Never');
check('relative sync time', formatTime(now - 17 * 60_000, now), '17m ago');
check('fresh provider is informative', providerState(undefined, true), { tone: 'idle', label: 'Ready to sync', detail: 'No sync has run yet.' });
check('disabled provider is paused', providerState(undefined, false).label, 'Paused');
check('offline error is actionable', friendlyError('cannot reach hstry-api at x'), 'The local hstry API is offline. Start it, then try again.');
check('login error is actionable', friendlyError('claude.ai: not logged in'), 'Open this provider and sign in, then sync again.');
check('recovered API makes stale offline failure retryable', providerState({
  lastRunMs: now - 27 * 60_000,
  lastError: 'cannot reach hstry-api at http://127.0.0.1:41770/ingest',
}, true, { apiConnected: true }), {
  tone: 'idle',
  label: 'Ready to retry',
  detail: 'The API is connected now. Run sync again.',
});
check('running provider exposes live phase', providerState({
  running: true,
  progress: { phase: 'importing', detected: 12, processed: 7, created: 3, updated: 2 },
}, true), {
  tone: 'syncing',
  label: 'Syncing',
  detail: '12 detected · 7 processed · 3 new · 2 updated',
});
check('queued provider explains continuation', providerState({
  continuationPending: true,
  progress: { phase: 'queued', detected: 219, processed: 10 },
}, true), {
  tone: 'syncing',
  label: 'Continuing',
  detail: '219 detected · 10 processed · next batch queued',
});
check('rate-limit cooldown shows a real wait instead of claiming active progress',
  providerState({ continuationPending: true, lastDeferredHttpStatus: 429,
    nextAllowedAtMs: Date.now() + 10 * 60_000,
    progress: { detected: 12, processed: 8 } }, true).label, 'Rate limit cooldown');
check('no server header is reported as unknown', providerState({
  continuationPending: true, lastDeferredHttpStatus: 429,
  nextAllowedAtMs: Date.now() + 15 * 60_000, state: {},
}, true).detail.includes('server Retry-After unavailable'), true);
check('server header time is distinguished from client schedule', providerState({
  continuationPending: true, lastDeferredHttpStatus: 429,
  nextAllowedAtMs: Date.now() + 15 * 60_000,
  state: { serverRetryAfterUntilMs: Date.now() + 2 * 60_000 },
}, true).detail.includes('server retry hint'), true);
check('progress detail omits empty counters', progressDetail({ detected: 4, processed: 1 }), '4 detected · 1 processed');
check('visible settings normalize before sync', normalizeSettings({
  port: '3434',
  token: ' hello ',
  intervalMinutes: '15',
  providers: { chatgpt: true, claude: true },
}, { port: 41770, intervalMinutes: 15 }), {
  port: 3434,
  token: 'hello',
  intervalMinutes: 15,
  providers: { chatgpt: true },
});
check('invalid port cannot escape form constraints', normalizeSettings({
  port: '70000',
  token: '',
  intervalMinutes: '0',
  providers: {},
}, { port: 41770, intervalMinutes: 15 }), {
  port: 41770,
  token: '',
  intervalMinutes: 15,
  providers: { chatgpt: false },
});

check('queued retry shows progress rather than a stale red badge',
  badgeState({ chatgpt: { continuationPending: true, lastError: 'Earlier request failed' } }),
  '…');
check('interrupted pending continuation shows progress',
  badgeState({ chatgpt: { running: false, progress: { phase: 'queued' } } }),
  '…');
check('genuine terminal error retains red indicator',
  badgeState({ chatgpt: { lastError: 'Authentication rejected', running: false } }),
  '!');
check('disabled provider cannot keep stale error indicator',
  badgeState({ chatgpt: { lastError: 'Authentication rejected' } }, { chatgpt: false }),
  '');
check('successful finished provider clears badge',
  badgeState({ chatgpt: { progress: { phase: 'complete' }, lastError: null } }),
  '');

process.exit(failures ? 1 : 0);
