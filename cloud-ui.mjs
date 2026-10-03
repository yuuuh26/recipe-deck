import * as api from './cloud-api.mjs';
import {createAutoBackup, snapshotOf} from './cloud-auto.mjs';
import {cloudCapture, replaceAll, all} from './db.mjs';
import {validateBackup} from './cloud-snapshot.mjs';
const $ = id => document.getElementById(id);
const date = value => value ? new Date(value).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo'}) : 'まだありません';
const node = (tag, text) => { const n = document.createElement(tag); n.textContent = text; return n; };
export async function initCloud({flush, restored, toast, download}) {
  let session = null, checking = null;
  const auto = createAutoBackup({notify(s) {
    const pending = s.revision > s.acknowledgedRevision;
    const text = s.sending ? 'クラウドへ保存中…' : !s.connected ? pending ? '端末に保存済み・クラウド未送信（ログインが必要）' : 'クラウド未接続' : pending ? '端末に保存済み・クラウド送信待ち' : s.lastSentAt ? 'クラウド保存済み' : '変更すると自動でクラウド保存';
    $('cloudSummary').textContent = text;
    $('cloudState').textContent = text;
    $('cloudPrevious').textContent = '前回のクラウド保存：' + date(s.lastSentAt);
    $('cloudError').textContent = s.message || '';
    $('cloudRetry').disabled = !s.connected || !pending || s.sending;
  }});
  $('cloudSummary').addEventListener('click', () => $('settingsShortcut').click());
  if (!api.hosted()) {
    $('cloudHosted').hidden = true; $('cloudMigration').hidden = false;
    $('cloudSummary').textContent = 'クラウド保存の設定 →';
    await auto.refresh();
    return auto;
  }
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      try { session = await api.sessionStatus(); await auto.setConnected(true); }
      catch (e) {
        if (e.status === 401) { session = null; await auto.setConnected(false); }
        else { $('cloudError').textContent = '通信できません。端末の保存内容を保持しています'; }
      }
      $('cloudLoginForm').hidden = !!session; $('cloudConnected').hidden = !session;
      $('cloudDeviceLabel').textContent = session ? '接続中：' + session.deviceName : '';
    })().finally(() => { checking = null; });
    return checking;
  }
  $('cloudLoginForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('cloudLogin'); button.disabled = true;
    try {
      session = await api.login($('cloudKey').value, $('cloudDevice').value);
      $('cloudKey').value = ''; await check(); toast('この端末を接続しました。変更分は自動で保存します');
    } catch (e) { $('cloudError').textContent = e.message; }
    finally { button.disabled = false; }
  });
  $('cloudLogout').addEventListener('click', async () => {
    try { await api.logout(); await check(); toast('この端末をログアウトしました'); }
    catch(e) { toast(e.message); }
  });
  $('cloudRetry').addEventListener('click', async () => { if (await flush()) await auto.run(); });
  $('cloudLoadHistory').addEventListener('click', async () => {
    $('cloudLoadHistory').disabled = true;
    try {
      const backups = await api.listBackups(), container = $('cloudHistory'); container.replaceChildren();
      if (!backups.length) container.append(node('p', 'クラウドのバックアップはまだありません'));
      for (const b of backups) {
        const row = node('div', ''); row.className = 'cloud-row';
        row.append(node('span', date(b.received_at || b.created_at) + ' · ' + b.record_count + '件'));
        const button = node('button', '内容を確認'); button.className = 'button outline';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const saved = await api.readBackup(b.backup_id), snapshot = await validateBackup(saved);
            $('cloudPreviewText').textContent = 'レシピ ' + snapshot.data.recipeCount + '件 / タグ ' + snapshot.data.tags.length + '件\n\n' + snapshot.data.recipes.slice(0,8).map(r => r.title).join('\n');
            $('cloudRestore').onclick = async () => {
              $('cloudRestore').disabled = true;
              try {
                if (!await flush()) return;
                const current = await cloudCapture();
                if (!confirm('端末のレシピ ' + current.recipes.length + '件を、このバックアップの ' + snapshot.data.recipeCount + '件で置き換えます。\n復元前の端末データも退避します。続けますか？')) return;
                await auto.exclusive(async () => {
                  await replaceAll(snapshot.data, {expectedRevision: current.meta.revision, recovery: snapshotOf(current).data});
                });
                await restored(snapshot.data); $('cloudPreview').close(); toast('復元しました。変更内容を自動でクラウドに保存します');
              } catch(e) { toast(e.message || '復元できませんでした'); }
              finally { $('cloudRestore').disabled = false; }
            };
            $('cloudPreview').showModal();
          } catch(e) { toast(e.message); }
          finally { button.disabled = false; }
        });
        row.append(button); container.append(row);
      }
    } catch(e) { toast(e.message); }
    finally { $('cloudLoadHistory').disabled = false; }
  });
  $('cloudClosePreview').addEventListener('click', () => $('cloudPreview').close());
  $('cloudRecoveryDownload').addEventListener('click', async () => {
    try {
      const recovery = (await all('cloud')).find(x => x.key === 'recovery');
      if (!recovery) { toast('復元前の退避データはまだありません'); return; }
      download(JSON.stringify(recovery.data, null, 2), 'recipe-deck-before-restore.json');
    } catch(e) { toast(e.message); }
  });
  async function renderSessions() {
    const sessions = await api.listSessions($('cloudAdminKey').value), container = $('cloudSessions'); container.replaceChildren();
    for (const s of sessions) {
      const row = node('div', ''); row.className = 'cloud-row';
      row.append(node('span', s.deviceName + (s.current ? '（この端末）' : '') + '\n最終利用：' + date(s.lastUsedAt)));
      const button = node('button', '接続を解除'); button.className = 'button outline';
      button.addEventListener('click', async () => {
        if (!confirm(s.deviceName + 'の接続を解除しますか？')) return;
        try { await api.revokeSession($('cloudAdminKey').value, s.id); await renderSessions(); await check(); }
        catch(e) { toast(e.message); }
      });
      row.append(button); container.append(row);
    }
    if (!sessions.length) container.append(node('p', '接続中の端末はありません'));
  }
  $('cloudListSessions').addEventListener('click', () => renderSessions().catch(e => toast(e.message)));
  $('cloudRevokeAll').addEventListener('click', async () => {
    if (!confirm('すべての端末の接続を解除しますか？クラウドのレシピは保持されます。')) return;
    try { await api.revokeSession($('cloudAdminKey').value); await renderSessions(); await check(); }
    catch(e) { toast(e.message); }
  });
  $('cloudAdmin').addEventListener('toggle', () => { if (!$('cloudAdmin').open) { $('cloudAdminKey').value = ''; $('cloudSessions').replaceChildren(); } });
  window.addEventListener('online', () => void check());
  window.addEventListener('offline', () => void auto.refresh());
  window.addEventListener('focus', () => void check());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  await auto.refresh(); await check(); return auto;
}
