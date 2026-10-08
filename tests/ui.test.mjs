import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import 'fake-indexeddb/auto';
import {CLOUD_ORIGIN} from '../cloud-api.mjs';
import {cloudCapture} from '../db.mjs';
const tick = ms => new Promise(r=>setTimeout(r,ms));
test('実際の編集画面は本文変更後だけ送信し、閲覧・検索・同じ評価では送らない',async()=>{
  const dom=new JSDOM(await readFile('index.html','utf8'),{url:CLOUD_ORIGIN+'/'});
  for(const name of ['window','document','location','Option']) globalThis[name]=dom.window[name];
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
  globalThis.scrollTo=()=>{};globalThis.confirm=()=>true;
  const sent=[], bodies=new Map();let statusChecks=0;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/v1/session')){statusChecks++;return Response.json({connected:true,deviceName:'テスト端末',sessionId:'test'})}
    if(options.method==='PUT'){const b=JSON.parse(options.body);sent.push(b);bodies.set(b.backup_id,b);return Response.json({backup_id:b.backup_id,sha256:b.sha256})}
    return Response.json(bodies.get(url.split('/').at(-1)));
  };
  await import('../app.mjs');
  while(!statusChecks)await tick(10);await tick(30);
  assert.equal(sent.length,0);
  document.getElementById('addRecipe').click();
  const text=document.getElementById('recipeText');text.value='鶏の照り焼き\n鶏肉を焼く';text.dispatchEvent(new dom.window.Event('input'));
  await tick(600);document.getElementById('backHome').click();
  await tick(3100);assert.equal(sent.length,1);assert.equal((await cloudCapture()).meta.acknowledgedRevision,1);
  assert.match(document.getElementById('cloudPrevious').textContent,/前回のクラウド保存：/);assert.doesNotMatch(document.getElementById('cloudPrevious').textContent,/まだありません/);
  document.querySelector('.recipe-card').click();document.getElementById('clearRating').click();
  await tick(600);document.getElementById('backHome').click();
  const keyword=document.getElementById('keyword');keyword.value='鶏';keyword.dispatchEvent(new dom.window.Event('input'));
  document.getElementById('settingsShortcut').click();await tick(50);
  assert.equal((await cloudCapture()).meta.revision,1);assert.equal(sent.length,1);
  assert.equal(document.getElementById('cloudLoginForm').hidden,true);assert.equal(document.getElementById('cloudConnected').hidden,false);
  // One-character note stays pending until leaving the editor.
  document.querySelector('[data-page="home"]').click();document.querySelector('.recipe-card').click();
  const notes=document.getElementById('notes');notes.value='塩';notes.dispatchEvent(new dom.window.Event('input'));
  await tick(600);assert.equal(sent.length,1);assert.match(document.getElementById('cloudState').textContent,/1\/10文字/);
  document.getElementById('brandHome').click();
  for(let i=0;i<100 && sent.length<2;i++)await tick(10);
  assert.equal(sent.length,2);
  for(let i=0;i<100 && (await cloudCapture()).meta.acknowledgedRevision<2;i++)await tick(10);
  assert.equal((await cloudCapture()).meta.acknowledgedRevision,2);
  assert.equal(document.getElementById('recipeSearch').open,false);
  document.querySelector('.recipe-card').click();
  const genre=document.getElementById('editorGenre'); genre.value='パスタ'; genre.dispatchEvent(new dom.window.Event('change'));
  await tick(600); document.getElementById('backHome').click();
  for(let i=0;i<100 && sent.length<3;i++)await tick(10);
  assert.equal(sent.length,3);assert.equal(JSON.parse(sent[2].backup_json).data.recipes[0].genre,'パスタ');
  assert.equal(document.querySelector('.genre-badge').textContent,'パスタ');
  document.getElementById('recipeSearch').open=true;
  const filterGenre=document.getElementById('filterGenre');filterGenre.value='genre:パスタ';filterGenre.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.getElementById('resultCount').textContent,'1 件');assert.match(document.getElementById('searchSummary').textContent,/パスタ.*絞り込み中/);
  document.getElementById('recipeSearch').open=false;
  assert.match(document.getElementById('searchSummary').textContent,/パスタ/);
  filterGenre.value='genre:鍋';filterGenre.dispatchEvent(new dom.window.Event('change'));
  assert.equal(document.getElementById('resultCount').textContent,'0 件');
  document.getElementById('clearSearch').click();
  assert.equal(document.getElementById('resultCount').textContent,'1 件');assert.equal(document.getElementById('keyword').value,'');
  assert.equal(sent.length,3);
  document.querySelector('.recipe-card').click();globalThis.prompt=()=> '丼物'; document.getElementById('createGenreHere').click();
  await tick(650);document.getElementById('backHome').click();
  assert.equal((await cloudCapture()).recipes[0].genre,'丼物');
  assert.ok((await cloudCapture()).settings[0].genreNames.includes('丼物'));
  document.querySelector('[data-page="export"]').click();
  assert.ok([...document.getElementById('exportGenre').options].some(option=>option.value==='genre:丼物'));
  document.getElementById('brandHome').click(); await tick(10);
  assert.ok(document.getElementById('home').classList.contains('active'));
  document.getElementById('settingsShortcut').click(); await tick(10);
  document.getElementById('brandHome').click(); await tick(10);
  assert.ok(document.getElementById('home').classList.contains('active'));
  for(let i=0;i<100;i++) {
    const captured=await cloudCapture();if(captured.meta.acknowledgedRevision===captured.meta.revision)break;
    await tick(20);
  }
  const captured=await cloudCapture();assert.equal(captured.meta.acknowledgedRevision,captured.meta.revision);
  await tick(30);
  dom.window.close();
});
test('サービスワーカーは認証やバックアップのGETをキャッシュに渡さない',async()=>{
  const listeners={};const self={location:{href:CLOUD_ORIGIN+'/service-worker.js',origin:CLOUD_ORIGIN},addEventListener:(name,fn)=>listeners[name]=fn};
  runInNewContext(await readFile('service-worker.js','utf8'),{self,URL});
  for(const path of ['/v1/session','/v1/backups','/v1/backups/id']){
    let intercepted=false;listeners.fetch({request:{method:'GET',url:CLOUD_ORIGIN+path},respondWith:()=>intercepted=true});assert.equal(intercepted,false);
  }
});
