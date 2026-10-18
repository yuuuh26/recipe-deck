import OAuthProvider,{AuthorizationError,CimdFetchError} from '@cloudflare/workers-oauth-provider';
import {OAuthStore} from './oauth-store';
import {AuthError,getSession,sameOrigin,verifyKey} from './sessions';
import {digest} from '../cloud-snapshot.mjs';
import type {Env} from './worker';

export const BASE='https://recipe-deck-backups.dengana-10011212.workers.dev';
const RESOURCE=BASE+'/mcp',SCOPE='recipes:draft',OWNER='recipe-owner';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const json=(body:any,status=200,headers:any={})=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const allowedHost=(value:string)=>{try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&['https://chatgpt.com','https://chat.openai.com'].includes(u.origin)}catch{return false}};
async function readBody(request:Request) {
  const reader=request.body?.getReader();if(!reader)throw new AuthError(400,'本文がありません');
  let size=0;const chunks:Uint8Array[]=[];
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>80*1024){await reader.cancel();throw new AuthError(413,'本文が大きすぎます')}chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
  return bytes;
}
async function readJson(request:Request) {
  if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))throw new AuthError(415,'JSONを指定してください');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBody(request)))}catch(error){if(error instanceof AuthError)throw error;throw new AuthError(400,'JSONを確認してください')}
}
async function rate(env:any,key:string,maximum:number) {
  const hour=Math.floor(Date.now()/3600000),bucket=await digest(key)+':'+hour;
  const row=await env.DB.prepare('INSERT INTO mcp_rate_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket,(hour+2)*3600).first();
  if(row.count>maximum)throw new AuthError(429,'送信回数が多いため、しばらく待ってください');
}
export async function rpc(request:Request,env:any,ctx:any) {
  if(ctx.props?.userId!==OWNER||!ctx.auth?.scope?.includes(SCOPE))return json({error:'権限がありません'},403);
  if(request.method!=='POST')return json({error:'POSTを使用してください'},405,{Allow:'POST'});
  const msg=await readJson(request),id=msg?.id??null;
  const result=(value:any)=>json({jsonrpc:'2.0',id,result:value});
  const error=(code:number,message:string)=>json({jsonrpc:'2.0',id,error:{code,message}});
  if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(msg.id!==undefined&&typeof msg.id!=='string'&&typeof msg.id!=='number'))return error(-32600,'Invalid Request');
  if(msg.id===undefined)return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
  if(msg.method==='initialize') {
    const versions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
    return result({protocolVersion:versions.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'recipe-deck',version:'1.5.2'},instructions:'Recipe Deckへ完成したレシピを新しい下書きとして送ります。ユーザーが送信を依頼した時だけ使用し、recipe_textにはレシピ本文だけを入れてください。既存レシピの閲覧・編集・削除はできません。'});
  }
  if(msg.method==='ping')return result({});
  if(msg.method==='tools/list')return result({tools:[{name:'create_recipe_draft',title:'レシピをRecipe Deckの下書きへ送る',description:'ユーザーがレシピデッキへの送信を依頼した時、完成したレシピ本文を新しい下書きとして追加します。アプリを開くと新規レシピ本文へ取り込まれます。既存の記録は読み取らず変更しません。会話履歴や認証情報を含めないでください。',inputSchema:{type:'object',properties:{recipe_text:{type:'string',minLength:1,maxLength:20000,description:'料理名・材料・作り方などを含むレシピ全文。改行を保持。'},request_id:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$',description:'送信ごとに新しい一意のID。通信失敗時の再送では同じIDを使用。'}},required:['recipe_text','request_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},securitySchemes:[{type:'oauth2',scopes:[SCOPE]}]}]});
  if(msg.method!=='tools/call')return error(-32601,'Method not found');
  if(msg.params?.name!=='create_recipe_draft')return error(-32602,'対応していないツールです');
  const a=msg.params.arguments;
  if(!a||typeof a.recipe_text!=='string'||!a.recipe_text.trim()||a.recipe_text.length>20000||typeof a.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(a.request_id)||Object.keys(a).some(k=>!['recipe_text','request_id'].includes(k)))return error(-32602,'本文と送信IDを確認してください');
  const hash=await digest(a.recipe_text);
  const existing=await env.DB.prepare('SELECT id,body_sha256 FROM mcp_drafts WHERE request_id=?').bind(a.request_id).first();
  if(existing&&existing.body_sha256!==hash)return result({isError:true,content:[{type:'text',text:'同じ送信IDで異なる本文は送れません。'}]});
  if(!existing){
    await rate(env,'draft:'+OWNER,30);
    const draftId=crypto.randomUUID();
    await env.DB.batch([env.DB.prepare('INSERT INTO mcp_drafts (id,request_id,body_sha256,recipe_text,created_at) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM mcp_drafts WHERE received_at IS NULL)<100 ON CONFLICT(request_id) DO NOTHING').bind(draftId,a.request_id,hash,a.recipe_text,new Date().toISOString())]);
  }
  const saved=await env.DB.prepare('SELECT id,body_sha256 FROM mcp_drafts WHERE request_id=?').bind(a.request_id).first();
  if(!saved||saved.body_sha256!==hash)return result({isError:true,content:[{type:'text',text:'下書きを保存できません。受信待ちの下書きを確認してください。'}]});
  return result({content:[{type:'text',text:'下書きを送信しました。Recipe Deckを開くと、新規レシピ本文に入力されます。'}],structuredContent:{draft_id:saved.id,status:'draft',app_url:BASE+'/#ai-drafts'}});
}

const provider=new OAuthProvider<any>({
  apiRoute:'/mcp',apiHandler:{fetch:rpc},
  defaultHandler:{async fetch(request,env){
    const path=new URL(request.url).pathname,oauth=env.OAUTH_PROVIDER;
    if(path==='/oauth/authorize'){
      if(request.method==='GET'){
        const parsed=await oauth.parseAuthRequest(request);
        if(!allowedHost(parsed.redirectUri)||(parsed.clientId.startsWith('https:')&&!allowedHost(parsed.clientId))||parsed.codeChallengeMethod!=='S256'||!parsed.codeChallenge||parsed.scope.some((s:string)=>![SCOPE,'offline_access'].includes(s)))throw new AuthError(400,'接続先・権限・認証方式を確認してください');
        const details=await oauth.describeConsent(parsed),consent=await oauth.beginConsent(parsed);
        // Native form POSTs use Origin:null under no-referrer. Keep the real
        // same-origin sender for CSRF validation, while hiding cross-site URLs.
        consent.headers.set('Content-Type','text/html;charset=utf-8');consent.headers.set('Cache-Control','no-store');consent.headers.set('Referrer-Policy','same-origin');
        const callback=new URL(parsed.redirectUri);
        // Chromium also checks form-action on the OAuth redirect after POST.
        consent.headers.set('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self' ${callback.origin}${callback.pathname}; frame-ancestors 'none'; base-uri 'none'`);
        return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recipe Deckへの接続</title><link rel="stylesheet" href="/style.css"><main class="oauth-page"><p class="eyebrow">RECIPE DECK</p><h1>ChatGPTから下書きを受け取る</h1><p>接続先：<strong>${escape(details.clientName)}</strong></p><p>認証結果の送信先：<strong>${escape(details.redirectHost)}</strong></p><p>許可する操作：<strong>新しいレシピ下書きの追加だけ</strong>。既存レシピの閲覧・上書き・削除やバックアップ復元の権限はありません。</p><p>アクセストークンは1時間、接続は最大30日で更新が必要になります。アプリの設定から接続を解除できます。</p><form id="oauthLogin" hidden><label for="oauthKey">この端末が未接続の場合はレシピ専用の復旧キー</label><input id="oauthKey" type="password" autocomplete="off" required><button class="button outline" type="submit">この端末を接続</button></form><form method="post" action="/oauth/authorize" id="oauthConsent"><input type="hidden" name="handle" value="${escape(consent.handle)}"><p id="oauthStatus" role="status">接続を確認中…</p><button class="button primary" id="oauthApprove" name="decision" value="approve" disabled>下書きの追加を許可して接続</button><button class="button outline" name="decision" value="deny">キャンセル</button></form><p class="signature">Made by YUU</p></main><script type="module" src="/oauth-ui.mjs"></script></html>`,{headers:consent.headers});
      }
      if(request.method==='POST'){
        sameOrigin(request);
        const form=await request.formData(),handle=String(form.get('handle')??'');
        if(form.get('decision')!=='approve'){const denied=await oauth.denyConsent(request,handle);denied.headers.set('Referrer-Policy','no-referrer');return new Response(null,{status:302,headers:denied.headers})}
        await getSession(request,env);
        const approved=await oauth.approveConsent(request,handle,{scope:[SCOPE,'offline_access']});
        const {redirectTo}=await oauth.completeAuthorization({request:approved.request,userId:OWNER,metadata:{label:'Recipe Deck 下書き追加'},scope:[SCOPE,'offline_access'],props:{userId:OWNER}});
        approved.headers.set('Location',redirectTo);approved.headers.set('Referrer-Policy','no-referrer');return new Response(null,{status:302,headers:approved.headers});
      }
    }
    if(path==='/v1/ai-drafts'&&request.method==='GET'){
      await getSession(request,env);
      const {results}=await env.DB.prepare('SELECT id,recipe_text,created_at FROM mcp_drafts WHERE received_at IS NULL ORDER BY created_at,id LIMIT 100').all();
      return json({drafts:results});
    }
    const ack=/^\/v1\/ai-drafts\/([0-9a-f-]{36})\/received$/.exec(path);
    if(ack&&request.method==='POST'){
      sameOrigin(request);await getSession(request,env);
      await env.DB.batch([env.DB.prepare('UPDATE mcp_drafts SET received_at=COALESCE(received_at,?) WHERE id=?').bind(new Date().toISOString(),ack[1])]);return json({received:true});
    }
    if(path==='/v1/mcp/revoke-all'&&request.method==='POST'){
      sameOrigin(request);await verifyKey(request,env);
      let cursor:string|undefined;
      do{const grants=await oauth.listUserGrants(OWNER,{limit:100,cursor});for(const grant of grants.items)await oauth.revokeGrant(grant.id,OWNER);cursor=grants.cursor;}while(cursor);
      return json({revoked:true});
    }
    return json({error:'APIがありません'},404);
  }},
  authorizeEndpoint:'/oauth/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
  accessTokenTTL:3600,refreshTokenTTL:2592000,scopesSupported:[SCOPE,'offline_access'],requiredScopes:[SCOPE],
  resourceMetadata:{resource:RESOURCE,authorization_servers:[BASE]},clientIdMetadataDocumentEnabled:true,
  clientRegistrationCallback:({clientMetadata}:any)=>Array.isArray(clientMetadata.redirect_uris)&&clientMetadata.redirect_uris.length&&clientMetadata.redirect_uris.every(allowedHost)?undefined:{code:'invalid_client_metadata',description:'ChatGPTからの接続だけを許可しています。'},
});
export default {async fetch(request:Request,env:Env,ctx:any={}) {
  try{
    if(new URL(request.url).origin!==BASE)return json({error:'配信元が一致しません'},400);
    const origin=request.headers.get('Origin');if(origin&&origin!==BASE)return json({error:'許可されていない配信元です'},403);
    if(Number(request.headers.get('Content-Length'))>80*1024)return json({error:'本文が大きすぎます'},413);
    const path=new URL(request.url).pathname;
    if(path.startsWith('/oauth/')){
      await rate(env,'auth:'+(request.headers.get('CF-Connecting-IP')??'unknown'),120);
      if(request.method==='POST'&&request.body)request=new Request(request,{body:await readBody(request)});
    }
    return await provider.fetch(request,{...env,OAUTH_KV:new OAuthStore(env.DB)},ctx);
  }catch(error){
    if(error instanceof AuthError)return json({error:error.message},error.status);
    if(error instanceof AuthorizationError||error instanceof CimdFetchError)return json({error:'接続リクエストを確認できません。ChatGPTから接続をやり直してください。'},400);
    return json({error:'連携処理を完了できませんでした。下書きと既存の記録は保持しています。'},500);
  }
}};
