import {APP_ID,validateBackup} from '../cloud-snapshot.mjs';
import {AuthError,verifyKey,getSession,sameOrigin,sessionCookie,sessionRoute} from './sessions';
import {confirmAndPrune} from './retention';
type Backup={backup_id:string;app_id:string;schema_version:number;created_at:string;device_id:string|null;record_count:number;source_revision:number;sha256:string;byte_length:number;backup_json:string};
type Statement={bind(...args:unknown[]):Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<{results:T[]}>};
type Database={prepare(sql:string):Statement;batch(statements:Statement[]):Promise<unknown[]>};
export type Env={DB:Database;BACKUP_TOKEN_SHA256:string};
const ORIGIN='https://yuuuh26.github.io';
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const columns='backup_id,app_id,schema_version,created_at,received_at,device_id,record_count,source_revision,sha256,byte_length';
class ApiError extends Error {constructor(public status:number,message:string){super(message)}}
function reply(body:unknown,status=200,cors=false) {
  return new Response(body===null?null:JSON.stringify(body),{status,headers:{
    'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','Vary':'Origin',
    'X-Content-Type-Options':'nosniff',...(cors?{'Access-Control-Allow-Origin':ORIGIN}:{})}});
}
async function bodyJson(request:Request) {
  const maximum=17*1024*1024;
  if(Number(request.headers.get('Content-Length'))>maximum)throw new ApiError(413,'リクエストが大きすぎます');
  if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))throw new ApiError(415,'JSONを指定してください');
  if(!request.body)throw new ApiError(400,'JSONがありません');
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maximum){await reader.cancel();throw new ApiError(413,'リクエストが大きすぎます')}text+=decoder.decode(value,{stream:true})}
    text+=decoder.decode();return JSON.parse(text);
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'JSONを確認できません')}
}
type Row=Omit<Backup,'backup_json'> & {received_at:string;chunk_count:number};
async function find(env:Env,id:string) {
  return env.DB.prepare(`SELECT ${columns},chunk_count FROM backups WHERE app_id=? AND backup_id=?`).bind(APP_ID,id).first<Row>();
}
async function readBackup(env:Env,id:string) {
  const row=await find(env,id);if(!row)throw new ApiError(404,'バックアップがありません');
  const chunks=(await env.DB.prepare('SELECT chunk_index,backup_json FROM backup_chunks WHERE backup_id=? ORDER BY chunk_index').bind(id).all<{chunk_index:number;backup_json:string}>()).results;
  if(chunks.length!==row.chunk_count||chunks.some((c,i)=>c.chunk_index!==i))throw new ApiError(500,'保存されたバックアップを照合できません');
  const {chunk_count,...metadata}=row;
  const backup={...metadata,backup_json:chunks.map(c=>c.backup_json).join('')};
  try{await validateBackup(backup)}catch{throw new ApiError(500,'保存されたバックアップを照合できません')}
  return backup;
}
async function writeBackup(env:Env,input:Backup,id:string) {
  try{await validateBackup(input)}catch{throw new ApiError(400,'バックアップの形式・件数・照合値を確認してください')}
  if(input.backup_id!==id)throw new ApiError(400,'バックアップIDが一致しません');
  const existing=await find(env,id);
  if(existing){const saved=await readBackup(env,id);if(saved.backup_json!==input.backup_json||saved.sha256!==input.sha256||saved.created_at!==input.created_at||saved.device_id!==input.device_id)throw new ApiError(409,'同じIDの別バックアップが存在します');await finishBackup(env,id);return {backup_id:id,sha256:input.sha256,already_exists:true}}
  // 200,000 UTF-16 code units use <=800,000 UTF-8 bytes, below D1's
  // 2MB per-row limit. <=42 chunks + metadata and retention inserts fit a 50-query batch.
  const chunks:string[]=[];
  for(let offset=0;offset<input.backup_json.length;){
    let end=Math.min(offset+200000,input.backup_json.length);
    const last=input.backup_json.charCodeAt(end-1);
    if(end<input.backup_json.length&&last>=0xd800&&last<=0xdbff)end--;
    chunks.push(input.backup_json.slice(offset,end));offset=end;
  }
  const statements=[env.DB.prepare('INSERT INTO backups (backup_id,app_id,schema_version,created_at,received_at,device_id,record_count,source_revision,sha256,byte_length,chunk_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,APP_ID,input.schema_version,input.created_at,new Date().toISOString(),input.device_id,input.record_count,input.source_revision,input.sha256,input.byte_length,chunks.length),
    env.DB.prepare('INSERT INTO backup_retention (backup_id,app_id) VALUES (?,?)').bind(id,APP_ID),
    ...chunks.map((text,index)=>env.DB.prepare('INSERT INTO backup_chunks (backup_id,chunk_index,backup_json) VALUES (?,?,?)').bind(id,index,text))];
  try{await env.DB.batch(statements)}catch{
    // Concurrent retries of an identical ID may lose the insert race.
    const winner=await find(env,id);
    if(winner){const saved=await readBackup(env,id);if(saved.backup_json===input.backup_json&&saved.created_at===input.created_at&&saved.device_id===input.device_id){await finishBackup(env,id);return {backup_id:id,sha256:input.sha256,already_exists:true}};throw new ApiError(409,'同じIDの別バックアップが存在します')}
    throw new ApiError(503,'クラウドに保存できませんでした。端末の記録を保持してください');
  }
  await finishBackup(env,id);
  return {backup_id:id,sha256:input.sha256,already_exists:false};
}
async function finishBackup(env:Env,id:string){
  await readBackup(env,id);
  try{await confirmAndPrune(env,id)}catch{throw new ApiError(503,'保存後の履歴整理を完了できませんでした。過去の履歴と端末の記録を保持しています。同じ送信を再試行してください')}
}
export default {async fetch(request:Request,env:Env):Promise<Response> {
  const origin=request.headers.get('Origin'),cors=origin===ORIGIN;
  let cookie:string|undefined;
  try{
    if(origin&&!cors&&origin!==new URL(request.url).origin)throw new ApiError(403,'許可されていないオリジンです');
    const url=new URL(request.url);
    if(request.method==='OPTIONS') {
      if(!cors)throw new ApiError(403,'許可されていないオリジンです');
      if(!['GET','PUT'].includes(request.headers.get('Access-Control-Request-Method')??''))throw new ApiError(405,'対応していない操作です');
      const headers=(request.headers.get('Access-Control-Request-Headers')??'').toLowerCase().split(',').map(h=>h.trim()).filter(Boolean);
      if(headers.some(h=>!['authorization','content-type'].includes(h)))throw new ApiError(403,'許可されていないヘッダーです');
      const response=reply(null,204,true);response.headers.set('Access-Control-Allow-Methods','GET, PUT');response.headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return response;
    }
    const authResponse=await sessionRoute(request,env,bodyJson);
    if(authResponse)return authResponse;
    if(request.headers.has('Authorization'))await verifyKey(request,env);
    else {
      // Retain Bearer-only access from the old Pages origin. A cookie never
      // authenticates a different app, even on the same parent domain.
      if(cors)throw new AuthError(401,'認証が必要です');
      if(!['GET','HEAD'].includes(request.method))sameOrigin(request);
      const auth=await getSession(request,env);cookie=sessionCookie(auth.token);
    }
    const respond=(body:unknown,status=200)=>{const response=reply(body,status,cors);if(cookie)response.headers.set('Set-Cookie',cookie);return response};
    if(url.pathname==='/v1/backups'&&request.method==='GET') {
      const cursor=url.searchParams.get('cursor');let time='',id='';
      if(cursor){try{[time,id]=JSON.parse(atob(cursor));if(!time||!idPattern.test(id)||new Date(time).toISOString()!==time)throw Error()}catch{throw new ApiError(400,'一覧の続き位置が不正です')}}
      const query=env.DB.prepare(`SELECT ${columns.split(',').map(c=>'b.'+c).join(',')} FROM backups b JOIN backup_retention r ON r.backup_id=b.backup_id WHERE b.app_id=? AND r.version_number IS NOT NULL ${cursor?'AND (b.received_at<? OR (b.received_at=? AND b.backup_id<?))':''} ORDER BY r.version_number DESC LIMIT 51`);
      const rows=(await (cursor?query.bind(APP_ID,time,time,id):query.bind(APP_ID)).all<Row>()).results;
      const backups=rows.slice(0,50),last=backups.at(-1);
      return respond({backups,next_cursor:rows.length>50&&last?btoa(JSON.stringify([last.received_at,last.backup_id])):null},200);
    }
    const match=/^\/v1\/backups\/([^/]+)$/.exec(url.pathname);
    if(!match||!idPattern.test(match[1]))throw new ApiError(404,'APIがありません');
    if(request.method==='GET')return respond(await readBackup(env,match[1]));
    if(request.method==='PUT')return respond(await writeBackup(env,await bodyJson(request),match[1]));
    throw new ApiError(405,'対応していない操作です');
  }catch(error){return reply({error:error instanceof ApiError||error instanceof AuthError?error.message:'クラウドで処理できませんでした'},error instanceof ApiError||error instanceof AuthError?error.status:500,cors)}
}};
