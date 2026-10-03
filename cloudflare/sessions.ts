import {APP_ID,digest} from '../cloud-snapshot.mjs';
import type {Env} from './worker';
export const COOKIE='__Host-recipe-session';
export class AuthError extends Error {constructor(public status:number,message:string){super(message)}}
export type Session={session_id:string;app_id:string;token_sha256:string;device_name:string;created_at:string;last_used_at:string;revoked_at:string|null};
const keyPattern=/^[A-Za-z0-9_-]{43,128}$/;
export async function verifyKey(request:Request,env:Env){
  if(!/^[0-9a-f]{64}$/.test(env.BACKUP_TOKEN_SHA256??''))throw new AuthError(503,'認証設定が完了していません');
  const match=/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(request.headers.get('Authorization')??'');
  if(!match)throw new AuthError(401,'復旧キーで本人確認してください');
  const actual=await digest(match[1]);let difference=0;
  for(let i=0;i<64;i++)difference|=actual.charCodeAt(i)^env.BACKUP_TOKEN_SHA256.charCodeAt(i);
  if(difference)throw new AuthError(401,'復旧キーを確認してください');
}
function cookieToken(request:Request){
  const values=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
  if(values.length!==1)return null;
  const token=values[0].slice(COOKIE.length+1);return keyPattern.test(token)?token:null;
}
// No Domain attribute: a sibling app cannot receive this cookie. Browser
// storage has a maximum cookie lifetime, renewed on authenticated activity.
// The server deliberately imposes no inactivity or absolute expiry.
export function sessionCookie(token:string|null){return `${COOKIE}=${token??''}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token?34560000:0}`}
export function sameOrigin(request:Request){
  const own=new URL(request.url).origin;
  if(request.headers.get('Origin')!==own)throw new AuthError(403,'このアプリから操作してください');
  const site=request.headers.get('Sec-Fetch-Site');
  if(site&&site!=='same-origin')throw new AuthError(403,'このアプリから操作してください');
}
export async function getSession(request:Request,env:Env){
  const origin=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
  if((origin&&origin!==new URL(request.url).origin)||(site&&site!=='same-origin'&&site!=='none'))throw new AuthError(403,'このアプリから操作してください');
  const token=cookieToken(request);
  if(!token)throw new AuthError(401,'この端末でログインしてください');
  const session=await env.DB.prepare('SELECT * FROM auth_sessions WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(APP_ID,await digest(token)).first<Session>();
  if(!session)throw new AuthError(401,'ログインが解除されています。復旧キーで再接続してください');
  await env.DB.batch([env.DB.prepare('UPDATE auth_sessions SET last_used_at=? WHERE app_id=? AND session_id=? AND revoked_at IS NULL').bind(new Date().toISOString(),APP_ID,session.session_id)]);
  return {session,token};
}
export async function sessionRoute(request:Request,env:Env,bodyJson:(r:Request)=>Promise<any>):Promise<Response|null>{
  const url=new URL(request.url),path=url.pathname;
  if(!['/v1/session','/v1/session/logout','/v1/sessions','/v1/sessions/revoke'].includes(path))return null;
  const reply=(data:unknown,status=200,cookie?:string)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})}});
  if(path==='/v1/session'&&request.method==='POST'){
    sameOrigin(request);await verifyKey(request,env);
    const body=await bodyJson(request);
    if(!body||typeof body.deviceName!=='string'||!body.deviceName.trim()||body.deviceName.length>80)throw new AuthError(400,'端末名は1〜80文字で入力してください');
    const bytes=crypto.getRandomValues(new Uint8Array(32));
    const token=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const id=crypto.randomUUID(),now=new Date().toISOString();
    // Reauthentication rotates this device's existing session. Other devices
    // stay connected; tokens are never placed in a response body or logs.
    const old=cookieToken(request),statements=[];
    if(old)statements.push(env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(now,APP_ID,await digest(old)));
    statements.push(env.DB.prepare('INSERT INTO auth_sessions (session_id,app_id,token_sha256,device_name,created_at,last_used_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)').bind(id,APP_ID,await digest(token),body.deviceName.trim(),now,now));
    await env.DB.batch(statements);
    return reply({connected:true,sessionId:id,deviceName:body.deviceName.trim()},200,sessionCookie(token));
  }
  if(path==='/v1/session'&&request.method==='GET'){
    const {session,token}=await getSession(request,env);
    return reply({connected:true,sessionId:session.session_id,deviceName:session.device_name},200,sessionCookie(token));
  }
  if(path==='/v1/session/logout'&&request.method==='POST'){
    sameOrigin(request);
    const token=cookieToken(request);
    if(token)await env.DB.batch([env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND token_sha256=? AND revoked_at IS NULL').bind(new Date().toISOString(),APP_ID,await digest(token))]);
    return reply({connected:false},200,sessionCookie(null));
  }
  if(path==='/v1/sessions'&&request.method==='POST'){
    sameOrigin(request);await verifyKey(request,env);
    const token=cookieToken(request),hash=token?await digest(token):null;
    const {results}=await env.DB.prepare('SELECT * FROM auth_sessions WHERE app_id=? AND revoked_at IS NULL ORDER BY last_used_at DESC').bind(APP_ID).all<Session>();
    return reply({sessions:results.map(s=>({id:s.session_id,deviceName:s.device_name,createdAt:s.created_at,lastUsedAt:s.last_used_at,current:s.token_sha256===hash}))});
  }
  if(path==='/v1/sessions/revoke'&&request.method==='POST'){
    sameOrigin(request);await verifyKey(request,env);const body=await bodyJson(request);
    if(!body||(body.all!==true&&(typeof body.sessionId!=='string'||!/^[-a-f0-9]{36}$/i.test(body.sessionId))))throw new AuthError(400,'解除する端末を選んでください');
    const now=new Date().toISOString();
    await env.DB.batch([body.all===true?env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').bind(now,APP_ID):env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE app_id=? AND session_id=? AND revoked_at IS NULL').bind(now,APP_ID,body.sessionId)]);
    return reply({revoked:true});
  }
  throw new AuthError(405,'対応していない操作です');
}
