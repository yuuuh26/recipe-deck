import {APP_ID} from '../cloud-snapshot.mjs';
import type {Env} from './worker';
const expired=`SELECT b.backup_id FROM backups b JOIN backup_retention r ON r.backup_id=b.backup_id WHERE b.app_id=? AND r.version_number IS NOT NULL ORDER BY r.version_number DESC LIMIT -1 OFFSET 5`;
// Call only after a complete, validated DB readback of the stored snapshot.
// The monotonic generation number is assigned inside the same transaction as
// pruning, so simultaneous sends and millisecond ties have a stable order.
export async function confirmAndPrune(env:Env,id:string){
  await env.DB.batch([
    env.DB.prepare('INSERT INTO backup_retention (backup_id,app_id) VALUES (?,?) ON CONFLICT(backup_id) DO NOTHING').bind(id,APP_ID),
    env.DB.prepare('UPDATE backup_retention SET verified_at=?,version_number=(SELECT COALESCE(MAX(version_number),0)+1 FROM backup_retention WHERE app_id=?) WHERE backup_id=? AND app_id=? AND version_number IS NULL').bind(new Date().toISOString(),APP_ID,id,APP_ID),
    env.DB.prepare(`DELETE FROM backup_chunks WHERE backup_id IN (${expired})`).bind(APP_ID),
    env.DB.prepare(`DELETE FROM backups WHERE backup_id IN (${expired})`).bind(APP_ID),
  ]);
}
