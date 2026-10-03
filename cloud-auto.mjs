import {backupExport} from './model.mjs';
import {createBackup} from './cloud-snapshot.mjs';
import {cloudCapture, cloudMeta, updateCloud, onDataChanged} from './db.mjs';
import {uploadBackup} from './cloud-api.mjs';
import {dirty, eager, ready, IDLE_DELAY} from './cloud-policy.mjs';
const defaults = {lastBackupRecipeCount: 0, lastBackupAt: null, createdSinceBackup: 0};
export function snapshotOf(captured) {
  const settings = {...defaults, ...captured.settings.find(s => s.key === 'main')};
  const data = backupExport(captured.recipes, captured.tags, settings);
  data.settings = settings;
  return {format: 'recipe-deck.snapshot', schema_version: 1, revision: captured.meta.revision, data};
}
export function createAutoBackup({capture = cloudCapture, meta = cloudMeta, update = updateCloud, upload = uploadBackup,
  makeBackup = createBackup, subscribe = onDataChanged, online = () => globalThis.navigator?.onLine !== false,
  notify = () => {}, delay = 3000, retryDelay = 15000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let connected = false, running = null, timer, retryCount = 0, stopped = false, lastMessage = '', planVersion = 0;
  const owner = crypto.randomUUID();
  function notifyState(m) { notify({...m, connected, sending: !!running, message: lastMessage}); }
  async function state(message) { if (message !== undefined) lastMessage = message; const m = await meta(); notifyState(m); return m; }
  function arm(ms, options = {}) {
    if (stopped) return;
    clearTimer(timer); timer = setTimer(() => { timer = null; return run({automatic:true, ...options}); }, ms);
  }
  async function plan() {
    const version = ++planVersion;
    clearTimer(timer); timer = null;
    const m = await meta();
    if (version !== planVersion || stopped) return;
    notifyState(m);
    if (!connected || !online() || !dirty(m)) return;
    if (eager(m)) arm(delay);
    else arm(Math.min(IDLE_DELAY, Math.max(0, m.lastEditAt + IDLE_DELAY - now())), {idleRevision:m.revision});
  }
  async function exclusive(fn) {
    const execute = async () => {
      const acquired = await update(m => {
        if (m.lease && m.lease.owner !== owner && m.lease.until > Date.now()) return false;
        m.lease = {owner, until: Date.now() + 120000}; return true;
      });
      if (!acquired) throw Error('別の画面でクラウド保存中です。少し待って再試行してください');
      try { return await fn(); }
      finally { await update(m => { if (m.lease?.owner === owner) delete m.lease; }); }
    };
    if (globalThis.navigator?.locks) return navigator.locks.request('recipe-deck-cloud', execute);
    return execute();
  }
  async function work({automatic = false, idleRevision} = {}) {
    const eligible = m => dirty(m) && (!automatic || ready(m, now()) || idleRevision === m.revision);
    let m = await state();
    if (!connected || !online() || !eligible(m)) return;
    await exclusive(async () => {
      const c = await capture(); m = c.meta;
      if (!connected || !online() || !eligible(m)) return;
      let attempt = m.attempt;
      if (!attempt) {
        const backup = await makeBackup(snapshotOf(c), m.deviceId);
        attempt = await update(current => {
          if (!current.attempt) current.attempt = {revision:m.revision, textChanges:m.textChanges ?? 0, backup};
          return current.attempt;
        });
      }
      await state('クラウドへ保存中…');
      await upload(attempt.backup);
      await update(current => {
        if (current.attempt?.backup.backup_id !== attempt.backup.backup_id) throw Error('保存待ちデータが変更されました');
        current.acknowledgedRevision = Math.max(current.acknowledgedRevision, attempt.revision);
        current.acknowledgedTextChanges = Math.max(current.acknowledgedTextChanges ?? 0, attempt.textChanges ?? 0);
        current.lastSentAt = new Date().toISOString(); current.attempt = null;
      });
      retryCount = 0; await state('');
    });
  }
  async function run(options) {
    ++planVersion; clearTimer(timer); timer = null;
    if (running) return running;
    let failed = false;
    running = work(options).catch(async error => {
      failed = true;
      if (error.status === 401) connected = false;
      await state(error.message || '通信できません。端末に保存して再送を待っています');
      if (connected && online()) arm(Math.min(retryDelay * 2 ** retryCount++, 300000));
    }).finally(async () => {
      running = null; await state();
      if (!failed || !timer) await plan();
    });
    return running;
  }
  const unsubscribe = subscribe(() => { retryCount = 0; void plan(); });
  return {
    run,
    async flushPending() {
      await update(m => { if (dirty(m)) m.immediateRevision = m.revision; });
      return run();
    },
    async setConnected(value) { if (value) lastMessage = ''; connected = value; retryCount = 0; await plan(); },
    refresh: plan,
    async exclusive(fn) { if (running) await running; return exclusive(fn); },
    stop() { stopped = true; ++planVersion; clearTimer(timer); unsubscribe(); }
  };
}
