import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';
import {createRecipeVersion, improvementPrompt, questionText, aiExport, backupExport, validateBackup, filterRecipes} from '../model.mjs';
import {all, putRecipe, putRecipeVersion, cloudCapture, replaceAll} from '../db.mjs';
import {createBackup, validateBackup as validateCloudBackup} from '../cloud-snapshot.mjs';

const initial = () => ({id:'versioned-recipe', title:'なすの炒め物', recipeText:'なすの炒め物\r\n\r\n醤油 大さじ2\r\nなすを炒める', notes:'家族の感想\n次も作りたい', rating:6, tagIds:[], genre:'炒め物', reflection:'味が濃い\nなすが硬い', nextChanges:'醤油を大さじ1に\nなすを先にレンジ加熱', createdAt:'2026-10-20T00:00:00.000Z', updatedAt:'2026-11-01T00:00:00.000Z'});
const settings={lastBackupRecipeCount:0,lastBackupAt:null,createdSinceBackup:0};
const improved='なすの炒め物\n\n醤油 大さじ1\nなすをレンジで加熱してから炒める\n';
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(await check())return;await tick(10);}assert.fail('処理が完了しませんでした');}

test('改良は平文と旧版の振り返りを完全に残し、復元も履歴を消さず新しい版になる',()=>{
  const recipe=initial(), before=structuredClone(recipe);
  const second=createRecipeVersion(recipe,improved,'醤油と加熱手順を変更','2026-11-02T00:00:00.000Z');
  assert.deepEqual(recipe,before);
  assert.equal(second.id,recipe.id);assert.equal(second.createdAt,recipe.createdAt);
  assert.equal(second.version,2);assert.equal(second.recipeText,improved);
  assert.equal(second.versions[0].recipeText,recipe.recipeText);
  assert.equal(second.versions[0].reflection,recipe.reflection);assert.equal(second.versions[0].nextChanges,recipe.nextChanges);
  assert.equal(second.versions[0].rating,6);assert.equal(second.rating,null);
  assert.equal(second.reflection,'');assert.equal(second.nextChanges,'');assert.equal(second.notes,recipe.notes);
  const third=createRecipeVersion(second,second.versions[0].recipeText,'第1版に戻す');
  assert.equal(third.version,3);assert.equal(third.versions.length,2);assert.equal(third.versions[1].recipeText,improved);
  assert.equal(third.recipeText,recipe.recipeText);
  assert.throws(()=>createRecipeVersion(second,''));assert.throws(()=>createRecipeVersion(second,improved));
});

test('AIへの平文・JSON出力と検索に反省点と次回の希望を含める',()=>{
  const recipe=initial(), prompt=improvementPrompt(recipe,[]);
  assert.ok(prompt.startsWith(recipe.recipeText));
  assert.match(prompt,/【前回の反省点】\n味が濃い/);assert.match(prompt,/【次回変更したいこと】\n醤油/);
  assert.match(prompt,/平文の全文/);assert.match(questionText(recipe,[]),/なすを先にレンジ加熱/);
  assert.equal(aiExport([recipe],[]).recipes[0].reflection,recipe.reflection);
  assert.equal(aiExport([recipe],[]).recipes[0].nextChanges,recipe.nextChanges);
  assert.equal(filterRecipes([recipe],{keyword:'先にレンジ'}).length,1);
});

test('旧形式を受け入れ、履歴と編集中の改良案をクラウド・JSONの往復で保持し、壊れた履歴は拒否する',async()=>{
  const old=initial();delete old.reflection;delete old.nextChanges;
  assert.equal(validateBackup(backupExport([old],[],settings)).recipes[0].version,undefined);
  const recipe={...createRecipeVersion(initial(),improved),improvementText:'次の改良案\n途中',improvementSummary:'次の試作'};
  const data=backupExport([recipe],[],settings);
  assert.deepEqual(validateBackup(JSON.parse(JSON.stringify(data))).recipes[0],recipe);
  const snapshot={format:'recipe-deck.snapshot',schema_version:1,revision:4,data};
  assert.deepEqual((await validateCloudBackup(await createBackup(snapshot))).data.recipes[0],recipe);
  for(const modify of [r=>r.version=3,r=>r.versions[0].recipeText='',r=>r.versions[0].version=2,r=>r.versions[0].rating=11,r=>r.nextChanges=null,r=>r.improvementText={},r=>r.versions[0].savedAt='broken']){
    const bad=structuredClone(data);modify(bad.recipes[0]);assert.throws(()=>validateBackup(bad));
  }
});

test('改良版は旧版と同時に確定し、別画面の更新と保存失敗では履歴を失わない',async()=>{
  const recipe={...initial(),id:'atomic-recipe'};await putRecipe(recipe);
  const second=createRecipeVersion(recipe,improved);await putRecipeVersion(second,recipe);
  const before=await cloudCapture();
  await assert.rejects(putRecipeVersion(createRecipeVersion(recipe,'古い画面からの改良'),recipe));
  await assert.rejects(putRecipe({...recipe,improvementText:'別画面で書いていた改良案'}));
  assert.deepEqual((await all('recipes')).find(r=>r.id===recipe.id),second);
  assert.equal((await cloudCapture()).meta.revision,before.meta.revision);
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){const req=original.call(this,value,...args);if(this.name==='recipes'&&value.id===recipe.id)queueMicrotask(()=>this.transaction.abort());return req;};
  try {await assert.rejects(putRecipeVersion(createRecipeVersion(second,'保存に失敗する改良'),second));}
  finally {IDBObjectStore.prototype.put=original;}
  assert.deepEqual((await all('recipes')).find(r=>r.id===recipe.id),second);
  assert.equal((await cloudCapture()).meta.revision,before.meta.revision);
});

test('実画面でメモ表示・コピー・貼り付け途中の保持・改良保存・旧版への復元がAPIなしで使える',async()=>{
  await replaceAll(backupExport([initial()],[],settings));
  const dom=new JSDOM(await readFile('index.html','utf8'),{url:'https://recipe-deck-backups.dengana-10011212.workers.dev/'});
  for(const name of ['window','document','location','Option'])globalThis[name]=dom.window[name];
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{copied=value;}}});
  globalThis.scrollTo=()=>{};globalThis.confirm=()=>true;
  const requests=[];globalThis.fetch=async(url)=>{requests.push(url);return url.endsWith('/v1/session')?Response.json({error:'未接続'},{status:401}):Response.json({drafts:[]});};
  await import('../app.mjs');await until(()=>document.querySelector('.recipe-card'));
  const $=id=>document.getElementById(id);
  const input=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new dom.window.Event('input'));};
  document.querySelector('.recipe-card').click();
  assert.equal($('recipeVersion').textContent,'第1版・最新版');
  $('openCookingMode').click();await until(()=>$('cookingDialog').open);
  assert.equal($('cookingReflectionText').textContent,initial().reflection);assert.equal($('cookingNextChangesText').textContent,initial().nextChanges);
  assert.equal($('cookingNextChanges').hidden,false);$('closeCookingMode').click();
  $('openImprovement').click();assert.equal($('improvementDialog').open,true);
  $('copyImprovement').click();await until(()=>copied);assert.match(copied,/味が濃い/);assert.match(copied,/平文の全文/);
  $('saveImprovement').click();await until(()=>$('improvementError').textContent);
  assert.equal((await all('recipes'))[0].version,undefined,'空の改良版では履歴を作らない');
  input('improvementText',improved);input('improvementSummary','減塩と下ごしらえ');
  $('closeImprovement').click();await until(async()=>(await all('recipes'))[0].improvementText===improved);
  $('backHome').click();await until(()=>$('home').classList.contains('active'));
  document.querySelector('.recipe-card').click();$('openImprovement').click();assert.equal($('improvementText').value,improved);
  $('saveImprovement').click();await until(()=>$('recipeVersion').textContent==='第2版・最新版');
  let saved=(await all('recipes'))[0];assert.equal(saved.versions[0].recipeText,initial().recipeText);assert.equal(saved.recipeText,improved);
  assert.equal($('recipeText').value,improved);assert.equal($('reflection').value,'');assert.equal($('nextChanges').value,'');
  assert.match($('versionHistoryList').textContent,/味が濃い/);assert.match($('versionHistoryList').textContent,/醤油を大さじ1/);
  $('openCookingMode').click();await until(()=>$('cookingDialog').open);assert.equal($('cookingReflection').hidden,true);assert.match($('cookingBody').textContent,/大さじ1/);$('closeCookingMode').click();
  document.querySelector('.version-entry button').click();await until(()=>$('improvementDialog').open);
  assert.equal($('improvementText').value,initial().recipeText.replace(/\r\n/g,'\n'));
  $('improvementText').dispatchEvent(new dom.window.Event('input'));$('saveImprovement').click();
  await tick(100);assert.equal($('improvementError').textContent,'');
  await until(()=>$('recipeVersion').textContent==='第3版・最新版');
  saved=(await all('recipes'))[0];assert.equal(saved.versions.length,2);assert.equal(saved.recipeText,initial().recipeText.replace(/\r\n/g,'\n'));
  assert.deepEqual(validateBackup(backupExport([saved],[],settings)).recipes[0],saved);
  assert.ok(requests.every(url=>url.endsWith('/v1/session')||url==='/v1/ai-drafts'),'AI APIへの通信は行わない');
  dom.window.close();
});
