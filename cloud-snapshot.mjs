import {validateBackup as validateData} from './model.mjs';
export const APP_ID = 'recipe-deck';
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export async function digest(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
export function parseSnapshot(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_SNAPSHOT_BYTES) throw Error('クラウド用バックアップは8MBまでです。完全バックアップJSONを保存してください');
  const s = JSON.parse(text);
  if (s?.format !== 'recipe-deck.snapshot' || s.schema_version !== 1 || !integer(s.revision)) throw Error('レシピ用バックアップの形式が違います');
  validateData(s.data);
  return s;
}
export async function createBackup(snapshot, deviceId = null) {
  const backup_json = JSON.stringify(snapshot), checked = parseSnapshot(backup_json);
  if (deviceId !== null && !uuid.test(deviceId)) throw Error('端末IDが不正です');
  return {backup_id: crypto.randomUUID(), app_id: APP_ID, schema_version: 1,
    created_at: new Date().toISOString(), device_id: deviceId, record_count: checked.data.recipeCount,
    source_revision: checked.revision, backup_json, sha256: await digest(backup_json), byte_length: new TextEncoder().encode(backup_json).length};
}
export async function validateBackup(v) {
  if (!v || !uuid.test(v.backup_id) || v.app_id !== APP_ID || v.schema_version !== 1 || !iso(v.created_at) ||
    (v.device_id !== null && !uuid.test(v.device_id)) || !integer(v.record_count) || !integer(v.source_revision) || !integer(v.byte_length) || !/^[0-9a-f]{64}$/.test(v.sha256)) throw Error('クラウド保存情報が不正です');
  const s = parseSnapshot(v.backup_json);
  if (v.record_count !== s.data.recipeCount || v.source_revision !== s.revision || v.byte_length !== new TextEncoder().encode(v.backup_json).length || v.sha256 !== await digest(v.backup_json)) throw Error('件数・サイズ・照合値が一致しません');
  return s;
}
