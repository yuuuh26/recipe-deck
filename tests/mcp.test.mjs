import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
const shim={name:'workers-test',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class WorkerEntrypoint {}'}));}};
await build({entryPoints:['cloudflare/mcp.ts'],bundle:true,format:'esm',platform:'node',outfile:'.test-build/mcp.mjs',plugins:[shim]});
const {default:mcp,BASE,rpc}=await import('../.test-build/mcp.mjs');
const migrations=(await Promise.all(['0001_backups','0002_sessions','0003_retention','0004_mcp_drafts'].map(n=>readFile('cloudflare/migrations/'+n+'.sql','utf8')))).join('\n');
const hash=s=>createHash('sha256').update(s).digest('hex');
const key='test-only-recovery-key-'+ 'x'.repeat(43),session='s'.repeat(43);
class D1 {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(migrations);}
  prepare(sql){const db=this.db;let args=[];return {bind(...values){args=values;return this},async first(){return db.prepare(sql).get(...args)??null},async all(){return {results:db.prepare(sql).all(...args)}},run(){return db.prepare(sql).run(...args)}};}
  async batch(statements){this.db.exec('BEGIN');try{const r=statements.map(s=>s.run());this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}}
}
function setup(){const env={DB:new D1(),BACKUP_TOKEN_SHA256:hash(key)};env.DB.db.prepare('INSERT INTO auth_sessions (session_id,app_id,token_sha256,device_name,created_at,last_used_at) VALUES (?,?,?,?,?,?)').run('test-session','recipe-deck',hash(session),'test','2026-10-18','2026-10-18');return env;}
const cookie='__Host-recipe-session='+session;
function req(path,method='GET',body,headers={}){return new Request(BASE+path,{method,headers,...(body!==undefined?{body}: {})});}
const context=()=>({waitUntil(){},passThroughOnException(){}});
const run=(env,r)=>mcp.fetch(r,env,context());
const post=(env,path,body,headers={})=>run(env,req(path,'POST',JSON.stringify(body),{'Content-Type':'application/json',...headers}));
async function authorize(env){
  const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
  const registration=await post(env,'/oauth/register',{client_name:'Recipe Deck test',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  assert.equal(registration.status,201,await registration.clone().text());const client=await registration.json();
  const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
  const query=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'recipes:draft offline_access',resource:BASE+'/mcp',code_challenge:challenge,code_challenge_method:'S256',state:'test-state'});
  const page=await run(env,req('/oauth/authorize?'+query));assert.equal(page.status,200,await page.clone().text());
  assert.equal(page.headers.get('Referrer-Policy'),'same-origin','Native form POST must preserve its Origin for CSRF checks');
  assert.match(page.headers.get('Content-Security-Policy'),/form-action 'self' https:\/\/chatgpt\.com\/connector_platform_oauth_redirect;/,'Chromium must be able to follow the approved callback');
  const dom=new JSDOM(await page.text(),{url:BASE+'/oauth/authorize?'+query});
  const consentForm=dom.window.document.getElementById('oauthConsent'),handle=consentForm.elements.namedItem('handle').value;
  assert.equal(consentForm.method,'post');assert.equal(consentForm.action,BASE+'/oauth/authorize');dom.window.close();
  const consentCookie=page.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const form=new URLSearchParams({handle,decision:'approve'});
  const missingSession=await run(env,req('/oauth/authorize','POST',form.toString(),{Origin:BASE,Cookie:consentCookie,'Content-Type':'application/x-www-form-urlencoded'}));assert.equal(missingSession.status,401);
  const nullOrigin=await run(env,req('/oauth/authorize','POST',form.toString(),{Origin:'null',Cookie:consentCookie+'; '+cookie,'Content-Type':'application/x-www-form-urlencoded'}));assert.equal(nullOrigin.status,403,'Null origins remain rejected');
  const approved=await run(env,req('/oauth/authorize','POST',form.toString(),{Origin:BASE,'Sec-Fetch-Site':'same-origin',Cookie:consentCookie+'; '+cookie,'Content-Type':'application/x-www-form-urlencoded'}));
  assert.equal(approved.headers.get('Referrer-Policy'),'no-referrer','The callback must not receive the consent page URL');
  assert.equal(approved.status,302,await approved.clone().text());const returned=new URL(approved.headers.get('Location'));assert.equal(returned.origin,'https://chatgpt.com');assert.equal(returned.searchParams.get('state'),'test-state');
  const tokenForm=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier,resource:BASE+'/mcp'});
  const exchanged=await run(env,req('/oauth/token','POST',tokenForm.toString(),{'Content-Type':'application/x-www-form-urlencoded'}));
  assert.equal(exchanged.status,200,await exchanged.clone().text());const tokens=await exchanged.json();assert.equal(tokens.expires_in,3600);assert.ok(tokens.refresh_token);
  return {...tokens,codeForm:tokenForm.toString()};
}
test('匿名・復旧キー・他オリジンではMCPを操作できず、メタデータだけ公開する',async()=>{
  const env=setup();
  const unauth=await post(env,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(unauth.status,401);assert.match(unauth.headers.get('WWW-Authenticate'),/resource_metadata/);
  assert.equal((await post(env,'/mcp',{},{Authorization:'Bearer '+key})).status,401);
  assert.equal((await run(env,req('/v1/ai-drafts'))).status,401);
  assert.equal((await post(env,'/mcp',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await run(env,req('/.well-known/oauth-authorization-server'))).status,200);
  assert.equal((await post(env,'/oauth/register',{redirect_uris:['https://evil.example/callback']})).status,400);
  assert.equal((await rpc(req('/mcp','POST','{}',{'Content-Type':'application/json'}),env,{props:{userId:'recipe-owner'},auth:{scope:['read']}})).status,403);
});
test('実際のOAuth/PKCE認証で下書きだけ追加でき、再送・受信・解除を安全に処理する',async()=>{
  const env=setup(),tokens=await authorize(env),headers={Authorization:'Bearer '+tokens.access_token};
  const call=msg=>post(env,'/mcp',{jsonrpc:'2.0',id:1,...msg},headers);
  const tools=await (await call({method:'tools/list'})).json();assert.deepEqual(tools.result.tools.map(t=>t.name),['create_recipe_draft']);
  const body='鶏となすの炒め物\n\n【材料】\n鶏肉\n【作り方】\n炒める。<img src=x onerror=alert(1)>';
  const command={method:'tools/call',params:{name:'create_recipe_draft',arguments:{recipe_text:body,request_id:'recipe_test_001'}}};
  const response=await (await call(command)).json();assert.ok(response.result.structuredContent.draft_id);
  const id=response.result.structuredContent.draft_id;
  await call(command);assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM mcp_drafts').get().n,1);
  const different=structuredClone(command);different.params.arguments.recipe_text='別のレシピ';assert.equal((await (await call(different)).json()).result.isError,true);
  assert.equal((await (await call({method:'tools/call',params:{name:'delete_recipe'}})).json()).error.code,-32602);
  const list=await run(env,req('/v1/ai-drafts','GET',undefined,{Cookie:cookie}));assert.equal(list.status,200,await list.clone().text());assert.equal((await list.json()).drafts[0].recipe_text,body);
  const path='/v1/ai-drafts/'+id+'/received';assert.equal((await run(env,req(path,'POST',undefined,{Origin:BASE}))).status,401);
  assert.equal((await run(env,req(path,'POST',undefined,{Origin:BASE,Cookie:cookie}))).status,200);
  assert.equal((await (await run(env,req('/v1/ai-drafts','GET',undefined,{Cookie:cookie}))).json()).drafts.length,0);
  assert.equal(env.DB.db.prepare('SELECT recipe_text FROM mcp_drafts').get().recipe_text,body,'Ack retains the cloud draft');
  assert.equal((await run(env,req('/v1/mcp/revoke-all','POST',undefined,{Origin:BASE,Cookie:cookie}))).status,401);
  const revoked=await run(env,req('/v1/mcp/revoke-all','POST',undefined,{Origin:BASE,Authorization:'Bearer '+key}));assert.equal(revoked.status,200,await revoked.clone().text());
  assert.equal((await call({method:'tools/list'})).status,401);
  assert.notEqual((await run(env,req('/oauth/token','POST',tokens.codeForm,{'Content-Type':'application/x-www-form-urlencoded'}))).status,200,'An authorization code cannot be replayed');
  assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM backups').get().n,0);
  assert.equal(env.DB.db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,1);
  const stored=JSON.stringify(env.DB.db.prepare('SELECT * FROM mcp_oauth_store').all());assert.ok(!stored.includes(tokens.access_token));assert.ok(!stored.includes(key));
});
