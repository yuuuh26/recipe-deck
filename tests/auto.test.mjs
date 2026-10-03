import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {write, putRecipe, putTag, putSettings, removeRecipe, removeTagEverywhere, replaceAll, cloudCapture, updateCloud, all} from '../db.mjs';
import {createAutoBackup, snapshotOf} from '../cloud-auto.mjs';
import {createBackup, validateBackup} from '../cloud-snapshot.mjs';
const settings = {createdSinceBackup:0,lastBackupAt:null,lastBackupRecipeCount:0};
const recipe = {id:'r',title:'カレー',recipeText:'カレー\n材料',notes:'',rating:null,tagIds:[],createdAt:'2026-10-03T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z'};
async function reset() {
  await write(['recipes','tags','settings','cloud'], tx => {
    for (const store of ['recipes','tags','settings','cloud']) tx.objectStore(store).clear();
    tx.objectStore('settings').put({key:'main',...settings});
  });
}
function harness(upload = async () => {}) {
  let sequence = 0; const timers = new Map(), sent = [], states = [];
  const auto = createAutoBackup({upload:async b => {sent.push(b);await upload(b)},notify:s=>states.push(s),
    setTimer:(fn,ms)=>{timers.set(++sequence,{fn,ms});return sequence},clearTimer:id=>timers.delete(id)});
  return {auto,timers,sent,states};
}
test('閲覧とファイルバックアップ日時の記録は送信せず、変更だけをまとめて保存する', async () => {
  await reset(); const h = harness();
  try {
    await h.auto.setConnected(true); await h.auto.run();
    await all('recipes'); await all('tags'); await putSettings({...settings,lastBackupAt:new Date().toISOString()});
    await h.auto.run(); assert.equal(h.sent.length,0);
    await putRecipe(recipe); await putRecipe({...recipe,notes:'甘口にする'});
    await putTag({id:'t',name:'定番',createdAt:recipe.createdAt});
    assert.equal(h.timers.size,1);
    await h.auto.run(); assert.equal(h.sent.length,1);
    const s = await validateBackup(h.sent[0]); assert.equal(s.revision,3); assert.equal(s.data.recipes[0].notes,'甘口にする'); assert.equal(s.data.tags.length,1);
    const c = await cloudCapture(); assert.equal(c.meta.acknowledgedRevision,3); assert.ok(c.meta.lastSentAt);assert.equal(c.meta.attempt,null);
    await h.auto.run();assert.equal(h.sent.length,1);
    await putRecipe({...recipe,tagIds:['t'],rating:8}); await h.auto.run();
    await removeTagEverywhere('t',[{...recipe,tagIds:['t']}],recipe.updatedAt); await h.auto.run();
    await removeRecipe('r'); await h.auto.run();
    assert.equal(h.sent.length,4);assert.equal((await validateBackup(h.sent.at(-1))).data.recipeCount,0);
  } finally {h.auto.stop();}
});
test('未接続とオフラインでは変更を端末に保持し、再起動後に送る', async () => {
  await reset(); const h = harness();
  await putRecipe(recipe); await h.auto.run(); assert.equal(h.sent.length,0); h.auto.stop();
  let online = false, sent = [];
  const auto = createAutoBackup({online:()=>online,upload:async b=>sent.push(b),setTimer:()=>1,clearTimer:()=>{}});
  try {
    await auto.setConnected(true); await auto.run(); assert.equal(sent.length,0);
    online = true; await auto.run(); assert.equal(sent.length,1);
  }finally{auto.stop()}
});
test('応答消失後は同じIDと内容を再送し、送信中の変更を次の保存に残す', async () => {
  await reset(); await putRecipe(recipe);
  let fail = true; const h = harness(async () => {if(fail)throw Error('lost response')});
  await h.auto.setConnected(true);await h.auto.run();assert.equal(h.sent.length,1);
  const pending = (await cloudCapture()).meta.attempt;assert.ok(pending);assert.equal((await cloudCapture()).meta.acknowledgedRevision,0);
  h.auto.stop(); const retries = harness();
  try {
    await retries.auto.setConnected(true);await retries.auto.run();assert.equal(retries.sent[0].backup_id,pending.backup.backup_id);assert.equal(retries.sent[0].backup_json,pending.backup.backup_json);
    let finish; const blocked = new Promise(r=>finish=r), during = harness(async () => blocked);
    await putRecipe({...recipe,notes:'先の変更'});await during.auto.setConnected(true);
    const sending = during.auto.run();
    while (!during.sent.length) await new Promise(r=>setImmediate(r));
    await putRecipe({...recipe,notes:'送信中の変更'});finish();await sending;
    const meta = (await cloudCapture()).meta;assert.ok(meta.revision > meta.acknowledgedRevision);
    await during.auto.run();assert.equal(during.sent.length,2);assert.equal((await validateBackup(during.sent[1])).data.recipes[0].notes,'送信中の変更');during.auto.stop();
  }finally{retries.auto.stop()}
});
test('2画面の同時送信は1回だけとなり、取り消された通行証は再送を止める', async () => {
  await reset();await putRecipe(recipe);const a=harness(),b=harness();
  try {
    await a.auto.setConnected(true);await b.auto.setConnected(true);await Promise.all([a.auto.run(),b.auto.run()]);
    assert.equal(a.sent.length+b.sent.length,1);
    await putRecipe({...recipe,notes:'変更'});
    const c=harness(async()=>{const e=Error('認証解除');e.status=401;throw e});
    await c.auto.setConnected(true);await c.auto.run();assert.equal(c.states.at(-1).connected,false);assert.equal(c.timers.size,0);c.auto.stop();
  }finally{a.auto.stop();b.auto.stop()}
});
test('失敗したローカル保存は変更番号を進めず、復元は同時変更を検知して退避する', async () => {
  await reset();await assert.rejects(write(['recipes'],tx=>{tx.objectStore('recipes').put(recipe);throw Error('failed')}));
  assert.equal((await cloudCapture()).meta.revision,0);assert.equal((await all('recipes')).length,0);
  await putRecipe(recipe);const before=await cloudCapture(), backup=snapshotOf(before);
  await putRecipe({...recipe,notes:'別の変更'});
  await assert.rejects(replaceAll(backup.data,{expectedRevision:before.meta.revision,recovery:backup.data}));assert.equal((await all('recipes'))[0].notes,'別の変更');
  const current=await cloudCapture();await replaceAll(backup.data,{expectedRevision:current.meta.revision,recovery:snapshotOf(current).data});
  assert.equal((await all('cloud')).find(x=>x.key==='recovery').data.recipes[0].notes,'別の変更');assert.equal((await all('recipes'))[0].notes,'');
  assert.equal((await cloudCapture()).meta.revision,3);
});
test('別アプリ・破損内容・不一致件数をクラウド送信前に拒否する',async()=>{
  await reset();await putRecipe(recipe);const b=await createBackup(snapshotOf(await cloudCapture()));
  for(const changed of [{...b,app_id:'karaoke-performance-log'},{...b,record_count:10},{...b,backup_json:'broken'},{...b,sha256:'0'.repeat(64)}])await assert.rejects(validateBackup(changed));
});
