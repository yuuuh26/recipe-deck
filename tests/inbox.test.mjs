import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';
import {all,putRecipe,putAiDraft,cloudCapture,saveImportedRecipe,removeRecipe,hasReceivedAiDraft} from '../db.mjs';
import {CLOUD_ORIGIN} from '../cloud-api.mjs';
const tick=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await tick(10);}assert.fail('処理が完了しませんでした');}
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const importedId=id=>'recipe_mcp_'+id;
test('確認なしで複数レシピを追加し、旧下書きの編集・編集中の別本文・再送後の削除を保護する',async()=>{
 const dom=new JSDOM(await readFile('index.html','utf8'),{url:CLOUD_ORIGIN+'/'});
 for(const name of ['window','document','location','Option'])globalThis[name]=dom.window[name];
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 globalThis.scrollTo=()=>{};let confirms=0;globalThis.confirm=()=>{confirms++;return true;};
 const existing={id:'original',title:'既存のレシピ',recipeText:'既存のレシピ\n大切な記録',notes:'保持',rating:8,tagIds:[],genre:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await putRecipe(existing);
 const incoming='AIからの料理\n【材料】\n<img src=x onerror=alert(1)>\n【作り方】\n炒める';
 await putAiDraft({id:ids[0],recipeText:incoming+'\n旧版で編集済み',createdAt:'2026-10-18T00:00:00.000Z',recipe:{...existing,id:importedId(ids[0]),notes:'旧下書きの備考',rating:7}});
 let remote=[{id:ids[0],recipe_text:incoming,created_at:'2026-10-18T00:00:00.000Z'},{id:ids[1],recipe_text:'二つ目の料理\n炒める',created_at:'2026-10-18T01:00:00.000Z'}];
 let listCalls=0,ackCalls=[],failAck=true;const backups=new Map();
 globalThis.fetch=async(url,options={})=>{
  if(url.endsWith('/v1/session'))return Response.json({connected:true,deviceName:'test'});
  if(url==='/v1/ai-drafts'){listCalls++;return Response.json({drafts:remote});}
  if(url.endsWith('/received')){ackCalls.push(url);return Response.json({}, {status:failAck&&url.includes(ids[0])?503:200});}
  if(options.method==='PUT'){const b=JSON.parse(options.body);backups.set(b.backup_id,b);return Response.json({backup_id:b.backup_id,sha256:b.sha256});}
  return Response.json(backups.get(url.split('/').at(-1))??{});
 };
 await import('../app.mjs');await until(async()=>(await all('recipes')).length===3&&document.getElementById('recipeText').value.includes('旧版で編集済み'));
 assert.equal(confirms,0);assert.equal(document.getElementById('aiDraftActions'),null);assert.equal(document.getElementById('aiSaveDraft'),null);
 assert.equal(document.querySelector('img[src="x"]'),null);assert.equal((await all('aiDrafts')).length,0);
 let imported=(await all('recipes')).find(r=>r.id===importedId(ids[0]));assert.equal(imported.notes,'旧下書きの備考');assert.equal(imported.rating,7);assert.match(imported.recipeText,/旧版で編集済み/);
 const text=document.getElementById('recipeText');text.value+='\n自動登録後も編集';text.dispatchEvent(new dom.window.Event('input'));await tick(550);
 assert.match((await all('recipes')).find(r=>r.id===imported.id).recipeText,/自動登録後も編集/);
 document.getElementById('backHome').click();await tick(30);
 const card=title=>[...document.querySelectorAll('.recipe-card')].find(c=>c.querySelector('h3').textContent===title);
 card(existing.title).click();text.value+='\n別レシピを編集中';text.dispatchEvent(new dom.window.Event('input'));
 const protectedText=text.value;
 remote.push({id:ids[2],recipe_text:'三つ目の料理\n煮る',created_at:'2026-10-18T02:00:00.000Z'});
 document.getElementById('aiRefresh').click();await until(async()=>(await all('recipes')).length===4);
 assert.equal(text.value,protectedText);assert.equal(confirms,0);await tick(550);
 document.getElementById('backHome').click();await tick(30);card('AIからの料理').click();document.getElementById('deleteRecipe').click();await until(async()=>!(await all('recipes')).some(r=>r.id===imported.id));
 failAck=false;const checks=listCalls;document.getElementById('aiRefresh').click();await until(()=>listCalls>checks);await tick(100);
 assert.equal((await all('recipes')).length,3,'削除したレシピは受信通知の再送で復活しない');
 assert.equal((await all('recipes')).find(r=>r.id==='original').recipeText,protectedText);
 assert.equal(document.querySelectorAll('.recipe-card').length,3);assert.equal((await all('aiDrafts')).length,0);
 // A failed transaction leaves the pending body and receipt unacknowledged.
 const originalAdd=IDBObjectStore.prototype.add;
 IDBObjectStore.prototype.add=function(value,...args){const request=originalAdd.call(this,value,...args);if(this.name==='recipes'&&value.id===importedId(ids[3]))queueMicrotask(()=>this.transaction.abort());return request;};
 remote.push({id:ids[3],recipe_text:'保存を再試行する料理\n焼く',created_at:'2026-10-18T03:00:00.000Z'});
 try{document.getElementById('aiRefresh').click();await until(async()=>(await all('aiDrafts')).some(d=>d.id===ids[3]));await tick(80);
  assert.equal(await hasReceivedAiDraft(ids[3]),false);assert.ok(!ackCalls.some(url=>url.includes(ids[3])));assert.equal((await all('recipes')).length,3);
 }finally{IDBObjectStore.prototype.add=originalAdd;}
 document.getElementById('aiRefresh').click();await until(async()=>(await all('recipes')).length===4);assert.equal((await all('aiDrafts')).length,0);
 const capture=await cloudCapture();assert.equal(capture.recipes.length,4);assert.ok(capture.meta.revision>=4);
 const before=listCalls;await tick(100);assert.equal(listCalls,before,'定期ポーリングは追加しない');
});
test('複数画面の同時受信は一度だけ確定し、削除後も再取り込みしない',async()=>{
 const draftId='55555555-5555-4555-8555-555555555555',recipe={id:importedId(draftId),title:'同時受信',recipeText:'同時受信\n材料と手順',rating:null,tagIds:[],genre:'',notes:'',createdAt:'2026-10-18T04:00:00.000Z',updatedAt:'2026-10-18T04:00:00.000Z'};
 const attempts=await Promise.allSettled([saveImportedRecipe(recipe,draftId),saveImportedRecipe({...recipe,recipeText:'重複する本文'},draftId)]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal((await all('recipes')).filter(r=>r.id===recipe.id).length,1);
 await removeRecipe(recipe.id);const revision=(await cloudCapture()).meta.revision;
 await assert.rejects(saveImportedRecipe(recipe,draftId));assert.equal((await cloudCapture()).meta.revision,revision);assert.ok(!(await all('recipes')).some(r=>r.id===recipe.id));
});
