import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';
import {all,putRecipe,putAiDraft,cloudCapture} from '../db.mjs';
import {CLOUD_ORIGIN} from '../cloud-api.mjs';
const tick=ms=>new Promise(r=>setTimeout(r,ms));
test('AI本文を未登録の編集画面へ取り込み、既存本文を保護して保存・再受信を重複させない',async()=>{
 const dom=new JSDOM(await readFile('index.html','utf8'),{url:CLOUD_ORIGIN+'/'});
 for(const name of ['window','document','location','Option'])globalThis[name]=dom.window[name];
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 globalThis.scrollTo=()=>{};globalThis.confirm=()=>true;
 const existing={id:'original',title:'既存のレシピ',recipeText:'既存のレシピ\n大切な記録',notes:'保持',rating:8,tagIds:[],genre:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await putRecipe(existing);
 const id='11111111-1111-4111-8111-111111111111',incoming='AIからの料理\n【材料】\n<img src=x onerror=alert(1)>\n【作り方】\n炒める';
 let listCalls=0,acks=0;const backups=new Map();
 globalThis.fetch=async(url,options={})=>{
  if(url.endsWith('/v1/session'))return Response.json({connected:true,deviceName:'test'});
  if(url==='/v1/ai-drafts'){listCalls++;return Response.json({drafts:[{id,recipe_text:incoming,created_at:'2026-10-18T00:00:00.000Z'}]});}
  if(url.endsWith('/received')){acks++;return Response.json({received:true});}
  if(options.method==='PUT'){const b=JSON.parse(options.body);backups.set(b.backup_id,b);return Response.json({backup_id:b.backup_id,sha256:b.sha256});}
  return Response.json(backups.get(url.split('/').at(-1))??{});
 };
 await import('../app.mjs');for(let i=0;i<100&&!listCalls;i++)await tick(10);await tick(50);
 assert.equal(document.getElementById('recipeText').value,incoming);assert.equal(document.getElementById('aiDraftActions').hidden,false);
 assert.equal((await all('recipes')).length,1,'Incoming draft is not silently registered');assert.equal(document.querySelector('img[src="x"]'),null);
 const text=document.getElementById('recipeText');text.value+='\n少し編集';text.dispatchEvent(new dom.window.Event('input'));await tick(550);
 assert.equal((await all('recipes')).length,1);assert.match((await all('aiDrafts'))[0].recipeText,/少し編集/);
 document.getElementById('aiSaveDraft').click();for(let i=0;i<100&&!acks;i++)await tick(10);
 assert.equal((await all('recipes')).length,2);assert.equal((await all('recipes')).find(r=>r.id==='original').recipeText,existing.recipeText);
 assert.equal((await all('aiDrafts')).length,0);assert.equal(document.getElementById('aiDraftActions').hidden,true);
 const imported=(await all('recipes')).find(r=>r.id!=='original');assert.match(imported.recipeText,/少し編集/);
 document.getElementById('backHome').click();await tick(30);
 document.querySelectorAll('.recipe-card')[0].click();const protectedText=document.getElementById('recipeText').value;
 document.getElementById('aiRefresh').click();await tick(60);assert.equal(document.getElementById('recipeText').value,protectedText);assert.equal((await all('recipes')).length,2);
 // Repeated direct imports fail instead of replacing an edited record.
 const {saveImportedRecipe}=await import('../db.mjs');await assert.rejects(saveImportedRecipe({...imported,recipeText:'上書きしない'},id));assert.equal((await all('recipes')).find(r=>r.id===imported.id).recipeText,imported.recipeText);
 assert.ok((await cloudCapture()).meta.revision>=2);
 const before=listCalls;await tick(100);assert.equal(listCalls,before,'No constant polling');
 dom.window.close();
});
