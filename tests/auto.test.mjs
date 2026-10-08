import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {write, putRecipe, putTag, putSettings, putGenreSettings, removeGenreEverywhere, removeRecipe, removeTagEverywhere, replaceAll, cloudCapture, updateCloud, all} from '../db.mjs';
import {createAutoBackup, snapshotOf} from '../cloud-auto.mjs';
import {changedCharacters, pendingCharacters} from '../cloud-policy.mjs';
import {createBackup, validateBackup} from '../cloud-snapshot.mjs';
const settings = {createdSinceBackup:0,lastBackupAt:null,lastBackupRecipeCount:0};
const recipe = {id:'r',title:'カレー',recipeText:'カレー\n材料',notes:'',rating:null,tagIds:[],createdAt:'2026-10-03T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z'};
async function reset() {
  await write(['recipes','tags','settings','cloud'], tx => {
    for (const store of ['recipes','tags','settings','cloud']) tx.objectStore(store).clear();
    tx.objectStore('settings').put({key:'main',...settings});
  });
}
function harness(upload = async () => {}, options = {}) {
  let sequence = 0; const timers = new Map(), sent = [], states = [];
  const auto = createAutoBackup({upload:async b => {sent.push(b);await upload(b)},notify:s=>states.push(s),
    setTimer:(fn,ms)=>{const id=++sequence;timers.set(id,{fn:()=>{timers.delete(id);return fn()},ms});return id},clearTimer:id=>timers.delete(id),...options});
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
    await h.auto.refresh(); assert.equal(h.timers.size,1);
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

test('10文字に届くまでは1分待ち、累計10文字で3秒待ちに切り替える',async()=>{
  await reset();const h=harness();
  try {
    await h.auto.setConnected(true);
    await putRecipe({...recipe,title:'味噌汁',recipeText:'味噌汁'});await h.auto.refresh();
    assert.equal(pendingCharacters((await cloudCapture()).meta),3);
    assert.equal(h.sent.length,0);assert.ok([...h.timers.values()][0].ms>59000);
    // Equal-length replacements count even when the total length is unchanged.
    await putRecipe({...recipe,title:'スープ',recipeText:'スープ'});await h.auto.refresh();
    assert.equal(pendingCharacters((await cloudCapture()).meta),6);assert.ok([...h.timers.values()][0].ms>59000);
    await putRecipe({...recipe,title:'スープ',recipeText:'スープ',notes:'塩を減らす'});await h.auto.refresh();
    assert.equal(pendingCharacters((await cloudCapture()).meta),11);assert.equal([...h.timers.values()][0].ms,3000);
    await [...h.timers.values()][0].fn();assert.equal(h.sent.length,1);assert.equal(pendingCharacters((await cloudCapture()).meta),0);
  }finally{h.auto.stop()}
});
test('短い修正は1分の無操作、画面を離れる操作、再起動後の期限到達で保存する',async()=>{
  await reset();const h=harness();
  try {
    await h.auto.setConnected(true);await putRecipe({...recipe,title:'味噌汁',recipeText:'味噌汁'});await h.auto.refresh();
    await [...h.timers.values()][0].fn();assert.equal(h.sent.length,1);
    await putRecipe({...recipe,title:'味噌汁',recipeText:'味噌汁',notes:'減塩'});await h.auto.refresh();
    assert.ok([...h.timers.values()][0].ms>59000);
    await h.auto.flushPending();assert.equal(h.sent.length,2);assert.equal(h.timers.size,0);
    await putRecipe({...recipe,title:'味噌汁',recipeText:'味噌汁',notes:'少し減塩'});h.auto.stop();
    const restarted=harness(async()=>{}, {now:()=>Date.now()+61000});
    try {await restarted.auto.setConnected(true);assert.equal([...restarted.timers.values()][0].ms,0);await [...restarted.timers.values()][0].fn();assert.equal(restarted.sent.length,1)}finally{restarted.auto.stop()}
  }finally{h.auto.stop()}
});
test('送信中に加えた少量の変更は文字数と1分待ちを引き継ぐ',async()=>{
  await reset();await putRecipe({...recipe,recipeText:'カレー\n材料は鶏肉を用意して作る'});
  let finish;const block=new Promise(r=>finish=r),h=harness(async()=>block);
  try {
    await h.auto.setConnected(true);const sending=h.auto.run();while(!h.sent.length)await new Promise(r=>setImmediate(r));
    await putRecipe({...recipe,recipeText:'カレー\n材料は鶏肉を用意して作る',notes:'減塩'});finish();await sending;
    assert.equal(pendingCharacters((await cloudCapture()).meta),2);assert.ok([...h.timers.values()][0].ms>59000);
    await h.auto.flushPending();assert.equal(h.sent.length,2);assert.equal(pendingCharacters((await cloudCapture()).meta),0);
  }finally{h.auto.stop()}
});
test('タグ・評価・削除・インポートは文字数なしでも3秒で送信を予約する',async()=>{
  await reset();await putRecipe(recipe);const h=harness();
  try {
    await h.auto.setConnected(true);await h.auto.run();
    for(const mutate of [
      ()=>putRecipe({...recipe,rating:8}),
      ()=>putTag({id:'t',name:'時短',createdAt:recipe.createdAt}),
      ()=>putRecipe({...recipe,rating:8,tagIds:['t']}),
      ()=>removeRecipe(recipe.id),
      async()=>replaceAll(snapshotOf(await cloudCapture()).data)
    ]) {
      await mutate();await h.auto.refresh();assert.equal([...h.timers.values()][0].ms,3000);
      await [...h.timers.values()][0].fn();
    }
    assert.equal(h.sent.length,6);
  }finally{h.auto.stop()}
});
test('ジャンル変更・追加・削除をすぐ送信し、復元後にも分類と独自ジャンルを保持する',async()=>{
  await reset(); await putRecipe(recipe); const h=harness();
  try {
    await h.auto.setConnected(true); await h.auto.run();
    await putRecipe({...recipe,genre:'パスタ'}); await h.auto.refresh();
    assert.equal([...h.timers.values()][0].ms,3000); await [...h.timers.values()][0].fn();
    let snapshot = await validateBackup(h.sent.at(-1)); assert.equal(snapshot.data.recipes[0].genre,'パスタ');
    await putGenreSettings({...settings,genreNames:['パスタ','丼物']}); await h.auto.refresh();
    assert.equal([...h.timers.values()][0].ms,3000); await [...h.timers.values()][0].fn();
    snapshot = await validateBackup(h.sent.at(-1)); assert.deepEqual(snapshot.data.settings.genreNames,['パスタ','丼物']);
    await replaceAll(snapshot.data);
    assert.equal((await all('recipes'))[0].genre,'パスタ'); assert.deepEqual((await all('settings'))[0].genreNames,['パスタ','丼物']);
    await removeGenreEverywhere('パスタ',await all('recipes'),{...settings,genreNames:['丼物']},recipe.updatedAt);
    await h.auto.refresh(); assert.equal([...h.timers.values()][0].ms,3000); await [...h.timers.values()][0].fn();
    snapshot = await validateBackup(h.sent.at(-1)); assert.equal(snapshot.data.recipes[0].genre,'');
    assert.equal(snapshot.data.recipes[0].recipeText,recipe.recipeText); assert.deepEqual(snapshot.data.settings.genreNames,['丼物']);
    await replaceAll({...snapshot.data,recipes:[recipe]}); assert.equal((await all('recipes'))[0].genre,undefined);
  } finally {h.auto.stop()}
});
test('通常の判定と閲覧では全レシピを読み込まず、旧版の未送信データを保持する',async()=>{
  await reset();let captures=0;const h=harness(async()=>{}, {capture:async()=>{captures++;return cloudCapture()}});
  try {
    await h.auto.setConnected(true);await h.auto.refresh();assert.equal(captures,0);
    await putRecipe(recipe);await h.auto.refresh();assert.equal(captures,0);
    await updateCloud(m=>{delete m.textChanges;delete m.lastEditAt;delete m.immediateRevision});await h.auto.refresh();
    assert.equal([...h.timers.values()][0].ms,3000);await [...h.timers.values()][0].fn();assert.equal(captures,1);assert.equal(h.sent.length,1);
  }finally{h.auto.stop()}
});
test('文字数は追加・削除・置換・離れた位置の修正・絵文字を正しく数える',()=>{
  assert.equal(changedCharacters('塩','塩を減らす'),4);
  assert.equal(changedCharacters('塩を減らす','塩'),4);
  assert.equal(changedCharacters('abc','xyz'),3);
  assert.equal(changedCharacters('a'+'.'.repeat(1000)+'b','x'+'.'.repeat(1000)+'y'),2);
  assert.equal(changedCharacters('','🍳味噌汁'),4);
  assert.equal(changedCharacters('あ'.repeat(10000),'い'.repeat(10000)),10);
  // Compare with an independent full edit-distance oracle on small strings.
  const oracle=(a,b)=>{a=Array.from(a);b=Array.from(b);const d=Array.from({length:a.length+1},(_,i)=>Array.from({length:b.length+1},(_,j)=>i===0?j:j===0?i:0));for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return Math.min(10,d[a.length][b.length])};
  const values=['','a','ab','abc','acb','bca','abcbabca','い🍳あ🍳','abababababab','babababababa'];
  for(const a of values)for(const b of values)assert.equal(changedCharacters(a,b),oracle(a,b));
});
