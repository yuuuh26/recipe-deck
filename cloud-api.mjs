import {validateBackup} from './cloud-snapshot.mjs';
export const CLOUD_ORIGIN = 'https://recipe-deck-backups.dengana-10011212.workers.dev';
export const hosted = () => globalThis.location?.origin === CLOUD_ORIGIN;
export class CloudError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function request(path, method = 'GET', body, key) {
  if (!hosted()) throw Error('クラウド保存はレシピ専用アドレスで利用してください');
  if (key !== undefined && !/^[A-Za-z0-9_-]{43,128}$/.test(key.trim())) throw Error('復旧キーを確認してください');
  const response = await fetch(CLOUD_ORIGIN + path, {method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: {...(key ? {Authorization: 'Bearer ' + key.trim()} : {}), ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new CloudError(response.status, data.error || 'クラウドと通信できませんでした');
  return data;
}
export const sessionStatus = () => request('/v1/session');
export const login = (key, deviceName) => request('/v1/session', 'POST', {deviceName}, key);
export const logout = () => request('/v1/session/logout', 'POST', {});
export const listSessions = async key => (await request('/v1/sessions', 'POST', {}, key)).sessions;
export const revokeSession = (key, sessionId) => request('/v1/sessions/revoke', 'POST', sessionId ? {sessionId} : {all: true}, key);
export const listBackups = async () => (await request('/v1/backups')).backups;
export async function readBackup(id) { const b = await request('/v1/backups/' + id); await validateBackup(b); return b; }
export async function uploadBackup(b) {
  await validateBackup(b);
  const result = await request('/v1/backups/' + b.backup_id, 'PUT', b);
  if (result.backup_id !== b.backup_id || result.sha256 !== b.sha256) throw Error('クラウドの保存応答が一致しません');
  const saved = await readBackup(b.backup_id);
  if (saved.backup_json !== b.backup_json || saved.sha256 !== b.sha256) throw Error('クラウドへの保存を照合できませんでした');
}
