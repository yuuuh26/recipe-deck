import {backupExport} from './model.mjs';
import {createBackup} from './cloud-snapshot.mjs';
import {cloudCapture, updateCloud, onDataChanged} from './db.mjs';
import {uploadBackup} from './cloud-api.mjs';
const defaults = {lastBackupRecipeCount: 0, lastBackupAt: null, createdSinceBackup: 0};
export function snapshotOf(captured) {
  const settings = {...defaults, ...captured.settings.find(s => s.key === 'main')};
  const data = backupExport(captured.recipes, captured.tags, settings);
  data.settings = settings;
  return {format: 'recipe-deck.snapshot', schema_version: 1, revision: captured.meta.revision, data};
}
export function createAutoBackup({capture = cloudCapture, update = updateCloud, upload = uploadBackup,
  makeBackup = createBackup, subscribe = onDataChanged, online = () => globalThis.navigator?.onLine !== false,
  notify = () => {}, delay = 3000, retryDelay = 15000, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let connected = false, running = null, timer, retryCount = 0, stopped = false, lastMessage = ''; 
  const owner = crypto.randomUUID();
  async function state(message) { if (message !== undefined) lastMessage = message; const c = await capture(); notify({...c.meta, connected, sending: !!running, message: lastMessage}); return c; }
  function schedule(ms = delay) {
    if (stopped) return;
    clearTimer(timer); timer = setTimer(() => { timer = null; void run(); }, ms);
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
  async function work() {
    let c = await state();
    if (!connected || !online() || c.meta.revision <= c.meta.acknowledgedRevision) return;
    await exclusive(async () => {
      c = await capture();
      if (!connected || c.meta.revision <= c.meta.acknowledgedRevision) return;
      let attempt = c.meta.attempt;
      if (!attempt) {
        const backup = await makeBackup(snapshotOf(c), c.meta.deviceId);
        attempt = await update(m => {
          if (!m.attempt) m.attempt = {revision: c.meta.revision, backup};
          return m.attempt;
        });
      }
      await state('クラウドへ保存中…');
      // Keep the immutable ID and payload on failure or a lost response.
      await upload(attempt.backup);
      await update(m => {
        if (m.attempt?.backup.backup_id !== attempt.backup.backup_id) throw Error('保存待ちデータが変更されました');
        m.acknowledgedRevision = Math.max(m.acknowledgedRevision, attempt.revision);
        m.lastSentAt = new Date().toISOString(); m.attempt = null;
      });
      retryCount = 0; await state('');
    });
  }
  async function run() {
    clearTimer(timer); timer = null;
    if (running) return running;
    running = work().catch(async error => {
      if (error.status === 401) connected = false;
      await state(error.message || '通信できません。端末に保存して再送を待っています');
      if (connected && online()) schedule(Math.min(retryDelay * 2 ** retryCount++, 300000));
    }).finally(async () => {
      running = null;
      const c = await state();
      if (!timer && connected && online() && c.meta.revision > c.meta.acknowledgedRevision) schedule();
    });
    return running;
  }
  const unsubscribe = subscribe(() => { retryCount = 0; schedule(); void state(); });
  return {
    run,
    async setConnected(value) { if (value) lastMessage = ''; connected = value; retryCount = 0; if (value) schedule(0); else { clearTimer(timer); timer = null; } await state(); },
    refresh: () => state(),
    async exclusive(fn) { if (running) await running; return exclusive(fn); },
    stop() { stopped = true; clearTimer(timer); unsubscribe(); }
  };
}
