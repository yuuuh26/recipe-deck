import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
await build({entryPoints:['cloudflare/worker.ts'],bundle:true,format:'esm',platform:'node',outdir:'.test-build',outbase:'.'});
const worker=(await import('../.test-build/cloudflare/worker.js')).default;
const {createBackup,digest}=await import('../cloud-snapshot.mjs');
const migration=await readFile('cloudflare/migrations/0001_backups.sql','utf8')+await readFile('cloudflare/migrations/0002_sessions.sql','utf8')+await readFile('cloudflare/migrations/0003_retention.sql','utf8');
class D1 {
  db=new DatabaseSync(':memory:'); calls=0; failBatch=false; failPrune=false;
  constructor(){this.db.exec(migration)}
  prepare(sql){const owner=this;return {sql,args:[],bind(...args){this.args=args;return this},async first(){owner.calls++;return owner.db.prepare(sql).get(...this.args)??null},async all(){owner.calls++;return {results:owner.db.prepare(sql).all(...this.args)}}}}
  async batch(statements){this.db.exec('BEGIN');try{for(const [i,s] of statements.entries()){this.calls++;this.db.prepare(s.sql).run(...s.args);if((this.failBatch&&i===0)||(this.failPrune&&s.sql.startsWith('DELETE FROM backup_chunks')))throw Error('interrupted batch')}this.db.exec('COMMIT');return statements.map(()=>({success:true}))}catch(e){this.db.exec('ROLLBACK');throw e}}
}
const token='test-only-token-'.padEnd(43,'x');
const origin='https://yuuuh26.github.io';
const data={schemaVersion:1,appVersion:'v1.3.0',exportType:'backup',exportedAt:'2026-10-03T00:00:00.000Z',recipeCount:1,recipes:[{id:'r',title:'カレー',recipeText:'カレー\n'+'🎤'.repeat(120000),notes:'保持',rating:8,tagIds:[],createdAt:'2026-10-03T00:00:00.000Z',updatedAt:'2026-10-03T00:00:00.000Z'}],tags:[],settings:{createdSinceBackup:0,lastBackupAt:null,lastBackupRecipeCount:0},backupMetadata:{tagCount:0,includesSettings:true}};
async function setup(){const DB=new D1();return {DB,BACKUP_TOKEN_SHA256:await digest(token)}}
function request(path,method='GET',body,headers={}){return new Request('https://test.workers.dev'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})})}
test('認証・CORSを拒否した要求はD1に触れず、設定不足は閉じた状態を維持する',async()=>{
  const env=await setup();
  for(const [headers,expected] of [[{Authorization:''},401],[{Authorization:'Bearer '+'z'.repeat(43)},401],[{Origin:'https://evil.example'},403]]) {
    assert.equal((await worker.fetch(request('/v1/backups','GET',null,headers),env)).status,expected);
  }
  assert.equal((await worker.fetch(request('/v1/backups'),{...env,BACKUP_TOKEN_SHA256:''})).status,503);
  assert.equal(env.DB.calls,0);
  const preflight=await worker.fetch(request('/v1/backups','OPTIONS',null,{'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'Authorization,Content-Type'}),env);
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'),null);
  assert.equal((await worker.fetch(request('/v1/backups','OPTIONS',null,{'Access-Control-Request-Method':'DELETE'}),env)).status,405);
});
test('複数チャンクの履歴保存・読み戻し・再試行・上書き拒否とバッチ失敗の原子性',async()=>{
  const env=await setup();const captured={format:'recipe-deck.snapshot',schema_version:1,revision:0,data};
  const backup=await createBackup(captured,crypto.randomUUID());
  assert.ok(backup.byte_length>200000);
  const path='/v1/backups/'+backup.backup_id;
  assert.equal((await worker.fetch(request(path,'PUT',backup),env)).status,200);
  const response=await worker.fetch(request(path),env);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const saved=await response.json();assert.equal(saved.backup_json,backup.backup_json);assert.equal(saved.sha256,backup.sha256);
  assert.ok(env.DB.db.prepare('SELECT chunk_count FROM backups').get().chunk_count>1);
  assert.equal((await worker.fetch(request(path,'PUT',backup),env)).status,200);
  const changed=await createBackup({...captured,data:{...data,recipes:data.recipes.map(r=>({...r,notes:'変更'}))}});changed.backup_id=backup.backup_id;
  assert.equal((await worker.fetch(request(path,'PUT',changed),env)).status,409);
  assert.equal((await worker.fetch(request(path,'DELETE'),env)).status,405);
  assert.throws(()=>env.DB.db.exec('DELETE FROM backups'));assert.throws(()=>env.DB.db.exec("UPDATE backup_chunks SET backup_json='broken'"));
  const second=await createBackup(captured);env.DB.failBatch=true;
  assert.equal((await worker.fetch(request('/v1/backups/'+second.backup_id,'PUT',second),env)).status,503);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,1);
  assert.equal((await worker.fetch(request('/v1/backups/'+second.backup_id),env)).status,404);
  env.DB.failBatch=false;
  assert.equal((await worker.fetch(request('/v1/backups/'+second.backup_id,'PUT',second),env)).status,200);
  const list=await (await worker.fetch(request('/v1/backups'),env)).json();assert.equal(list.backups.length,2);assert.equal(list.next_cursor,null);assert.ok(list.backups.every(row=>!('backup_json' in row)));
  assert.equal((await worker.fetch(request('/v1/backups?cursor=invalid'),env)).status,400);
  assert.equal((await worker.fetch(request('/v1/backups/'+crypto.randomUUID(),'PUT',{...backup,backup_json:'broken'}),env)).status,400);
});
const own='https://test.workers.dev';
function sessionRequest(path,method='GET',body,headers={}){return new Request(own+path,{method,headers:{Origin:own,'Sec-Fetch-Site':'same-origin',...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})})}
async function signIn(env,name='この端末',cookie){const response=await worker.fetch(sessionRequest('/v1/session','POST',{deviceName:name},{Authorization:'Bearer '+token,...(cookie?{Cookie:cookie}:{})}),env);assert.equal(response.status,200);return {cookie:response.headers.get('Set-Cookie').split(';')[0],data:await response.json(),headers:response.headers}}
test('端末通行証は秘密Cookieで保持し、期限なし・アプリ限定・別オリジン拒否を守る',async()=>{
  const env=await setup();
  assert.equal((await worker.fetch(sessionRequest('/v1/session','POST',{deviceName:'test'}),env)).status,401);assert.equal(env.DB.calls,0);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','POST',null,{Authorization:'Bearer '+token}),env)).status,415);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','POST',[],{Authorization:'Bearer '+token}),env)).status,400);
  const first=await signIn(env);
  const header=first.headers.get('Set-Cookie');assert.match(header,/^__Host-recipe-session=/);assert.match(header,/; Secure;/);assert.match(header,/; HttpOnly;/);assert.match(header,/SameSite=Strict/);assert.match(header,/Max-Age=34560000/);assert.doesNotMatch(header,/Domain=/);assert.doesNotMatch(header,new RegExp(token));
  const plaintext=first.cookie.split('=')[1],row=env.DB.db.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(row.token_sha256,await digest(plaintext));assert.notEqual(row.token_sha256,plaintext);assert.ok(!JSON.stringify(first.data).includes(plaintext));
  // Even very old dates are not an expiration policy.
  env.DB.db.prepare("UPDATE auth_sessions SET created_at='1900-01-01T00:00:00.000Z',last_used_at='1900-01-01T00:00:00.000Z'").run();
  assert.equal((await worker.fetch(sessionRequest('/v1/backups','GET',null,{Cookie:first.cookie}),env)).status,200);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:first.cookie,Origin:'','Sec-Fetch-Site':'none'}),env)).status,200);
  for(const headers of [{Origin:'https://other.test.workers.dev'},{'Sec-Fetch-Site':'same-site'},{Cookie:first.cookie+'; '+first.cookie},{Origin:origin}]){
    assert.ok([401,403].includes((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:first.cookie,...headers}),env)).status));
  }
  assert.equal((await worker.fetch(sessionRequest('/v1/backups/'+crypto.randomUUID(),'PUT',{}, {Cookie:first.cookie,Origin:''}),env)).status,403);
  assert.equal((await worker.fetch(sessionRequest('/v1/sessions','POST',{}, {Cookie:first.cookie}),env)).status,401);
  env.DB.db.prepare("UPDATE auth_sessions SET app_id='other-app'").run();
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:first.cookie}),env)).status,401);
});
test('復旧キーでだけ端末管理ができ、個別解除・全解除・再接続・ログアウトが機能する',async()=>{
  const env=await setup(),a=await signIn(env,'スマホ'),b=await signIn(env,'PC');
  const admin={Authorization:'Bearer '+token,Cookie:a.cookie};
  const response=await worker.fetch(sessionRequest('/v1/sessions','POST',{},admin),env);const list=await response.json();
  assert.equal(list.sessions.length,2);assert.equal(list.sessions.find(s=>s.id===a.data.sessionId).current,true);
  assert.ok(list.sessions.every(s=>!('token_sha256' in s)&&!('token' in s)));
  assert.equal((await worker.fetch(sessionRequest('/v1/sessions/revoke','POST',{sessionId:a.data.sessionId},{Cookie:a.cookie}),env)).status,401);
  assert.equal((await worker.fetch(sessionRequest('/v1/sessions/revoke','POST',{sessionId:a.data.sessionId},{...admin,Origin:'https://evil.example'}),env)).status,403);
  assert.equal((await worker.fetch(sessionRequest('/v1/sessions/revoke','POST',{sessionId:b.data.sessionId},admin),env)).status,200);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:b.cookie}),env)).status,401);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:a.cookie}),env)).status,200);
  const rotated=await signIn(env,'スマホ再接続',a.cookie);
  assert.notEqual(rotated.cookie,a.cookie);assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:a.cookie}),env)).status,401);
  const backup=await createBackup(smallSnapshot('auth'));
  assert.equal((await worker.fetch(sessionRequest('/v1/backups/'+backup.backup_id,'PUT',backup,{Cookie:rotated.cookie}),env)).status,200);
  assert.equal((await worker.fetch(sessionRequest('/v1/backups/'+backup.backup_id,'GET',null,{Cookie:rotated.cookie}),env)).status,200);
  const loggedOut=await worker.fetch(sessionRequest('/v1/session/logout','POST',{}, {Cookie:rotated.cookie}),env);assert.equal(loggedOut.status,200);assert.match(loggedOut.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:rotated.cookie}),env)).status,401);
  const c=await signIn(env,'タブレット'),d=await signIn(env,'予備');
  assert.equal((await worker.fetch(sessionRequest('/v1/sessions/revoke','POST',{all:true},admin),env)).status,200);
  for(const device of [c,d])assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:device.cookie}),env)).status,401);
  // Revoke affects authentication only; original recovery access + data survive.
  assert.equal((await worker.fetch(request('/v1/backups/'+backup.backup_id),env)).status,200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,1);
});
test('再認証中のDB失敗は旧端末通行証を原子的に保持する',async()=>{
  const env=await setup(),old=await signIn(env);env.DB.failBatch=true;
  assert.equal((await worker.fetch(sessionRequest('/v1/session','POST',{deviceName:'再接続'},{Authorization:'Bearer '+token,Cookie:old.cookie}),env)).status,500);
  env.DB.failBatch=false;
  assert.equal((await worker.fetch(sessionRequest('/v1/session','GET',null,{Cookie:old.cookie}),env)).status,200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,1);
});
const smallSnapshot=(label)=>({format:'recipe-deck.snapshot',schema_version:1,revision:0,data:{...data,recipes:data.recipes.map(r=>({...r,recipeText:'カレー',notes:label}))}});
const verifiedIds=env=>env.DB.db.prepare('SELECT backup_id FROM backup_retention WHERE version_number IS NOT NULL ORDER BY version_number').all().map(r=>r.backup_id);
async function put(env,backup){return worker.fetch(request('/v1/backups/'+backup.backup_id,'PUT',backup),env)}
test('最新5世代を端末共通で保持し、同時刻の送信・再試行・時計ずれでも世代数を正しく扱う',async()=>{
  const env=await setup(),items=[],OriginalDate=Date;
  globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:['2026-10-03T00:00:00.000Z']))}static now(){return OriginalDate.parse('2026-10-03T00:00:00.000Z')}};
  try{
    for(let i=0;i<9;i++){
      const snapshot=i===0?{format:'recipe-deck.snapshot',schema_version:1,revision:0,data}:smallSnapshot('version'+i);
      const b=await createBackup(snapshot,crypto.randomUUID());
      // A client's clock does not decide which generation to delete.
      b.created_at=i%2?'2099-01-01T00:00:00.000Z':'2000-01-01T00:00:00.000Z';items.push(b);
      assert.equal((await put(env,b)).status,200);
      assert.deepEqual(verifiedIds(env),items.slice(-5).map(x=>x.backup_id));
    }
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,5);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backup_retention').get().n,5);
    for(const b of items.slice(0,4)){
      assert.equal((await worker.fetch(request('/v1/backups/'+b.backup_id),env)).status,404);
      assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backup_chunks WHERE backup_id=?').get(b.backup_id).n,0);
    }
    for(const b of items.slice(-5))assert.equal((await worker.fetch(request('/v1/backups/'+b.backup_id),env)).status,200);
    const before=verifiedIds(env);await put(env,items.at(-2));assert.deepEqual(verifiedIds(env),before);
    const list=await (await worker.fetch(request('/v1/backups'),env)).json();assert.deepEqual(list.backups.map(x=>x.backup_id),before.toReversed());
    assert.throws(()=>env.DB.db.prepare('DELETE FROM backups WHERE backup_id=?').run(items.at(-1).backup_id));
    assert.throws(()=>env.DB.db.prepare('DELETE FROM backup_chunks WHERE backup_id=?').run(items.at(-1).backup_id));
  }finally{globalThis.Date=OriginalDate}
});
test('保存失敗・整理失敗・読み戻し破損では旧5世代を維持し、保留分の再試行後に安全に整理する',async()=>{
  const env=await setup(),items=[];
  for(let i=0;i<5;i++){const b=await createBackup(smallSnapshot('v'+i));items.push(b);assert.equal((await put(env,b)).status,200)}
  const before=verifiedIds(env),sixth=await createBackup(smallSnapshot('sixth'));
  env.DB.failBatch=true;assert.equal((await put(env,sixth)).status,503);env.DB.failBatch=false;assert.deepEqual(verifiedIds(env),before);assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,5);
  env.DB.failPrune=true;assert.equal((await put(env,sixth)).status,503);env.DB.failPrune=false;assert.deepEqual(verifiedIds(env),before);
  assert.equal(env.DB.db.prepare('SELECT version_number FROM backup_retention WHERE backup_id=?').get(sixth.backup_id).version_number,null);
  assert.throws(()=>env.DB.db.prepare('DELETE FROM backup_chunks WHERE backup_id=?').run(sixth.backup_id));
  // Simulate a corrupted round trip without mutating stored history.
  const prepare=env.DB.prepare.bind(env.DB),bad=await createBackup(smallSnapshot('bad-readback'));
  env.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('SELECT chunk_index')){const all=s.all;s.all=async function(){const result=await all.call(this);return {results:result.results.map(r=>({...r,backup_json:'broken'}))}}}return s};
  assert.equal((await put(env,bad)).status,500);assert.deepEqual(verifiedIds(env),before);env.DB.prepare=prepare;
  const seventh=await createBackup(smallSnapshot('seventh'));assert.equal((await put(env,seventh)).status,200);
  assert.deepEqual(verifiedIds(env),[...before.slice(1),seventh.backup_id]);
  // Pending versions are not counted towards the five verified slots.
  assert.equal((await put(env,sixth)).status,200);assert.equal((await put(env,bad)).status,200);
  assert.deepEqual(verifiedIds(env),[...before.slice(3),seventh.backup_id,sixth.backup_id,bad.backup_id]);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,5);
  assert.equal(env.DB.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('既存履歴は移行だけでは削除せず、再実行でも世代番号を保ち、次の成功送信で5世代に整理する',async()=>{
  const env=await setup();env.DB.db.close();env.DB.db=new DatabaseSync(':memory:');env.DB.db.exec(await readFile('cloudflare/migrations/0001_backups.sql','utf8'));
  const items=[];
  for(let i=0;i<7;i++){
    const b=await createBackup(smallSnapshot('legacy'+i));items.push(b);
    env.DB.db.prepare('INSERT INTO backups VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(b.backup_id,b.app_id,b.schema_version,b.created_at,`2026-10-0${i+1}T00:00:00.000Z`,b.device_id,b.record_count,b.source_revision,b.sha256,b.byte_length,1);
    env.DB.db.prepare('INSERT INTO backup_chunks VALUES (?,?,?)').run(b.backup_id,0,b.backup_json);
  }
  const sql=await readFile('cloudflare/migrations/0003_retention.sql','utf8');env.DB.db.exec(sql);const before=verifiedIds(env);assert.deepEqual(before,items.map(b=>b.backup_id));env.DB.db.exec(sql);assert.deepEqual(verifiedIds(env),before);
  const cursor=btoa(JSON.stringify(['2026-10-05T00:00:00.000Z',items[4].backup_id]));
  const page=await worker.fetch(request('/v1/backups?cursor='+encodeURIComponent(cursor)),env);assert.equal(page.status,200);assert.equal((await page.json()).backups.length,4);
  const newBackup=await createBackup(smallSnapshot('new'));assert.equal((await put(env,newBackup)).status,200);
  assert.deepEqual(verifiedIds(env),[...before.slice(-4),newBackup.backup_id]);assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n,5);
});
