// KV-compatible persistence for the pinned Cloudflare OAuth library. Keeping
// this in the existing app's D1 avoids granting account-wide KV permissions.
// The library owns token hashing, encrypted props, PKCE and consent validation.
export class OAuthStore {
  constructor(private db:any) {}
  async get(key:string, options:any={}) {
    const row=await this.db.prepare('SELECT value FROM mcp_oauth_store WHERE key=? AND (expires_at IS NULL OR expires_at>?)').bind(key,Math.floor(Date.now()/1000)).first();
    if(!row)return null;
    const type=typeof options==='string'?options:options.type;
    if(type==='json')return JSON.parse(row.value);
    if(type==='arrayBuffer')return new TextEncoder().encode(row.value).buffer;
    return row.value;
  }
  async put(key:string,value:string,options:any={}) {
    if(typeof value!=='string')throw new TypeError('OAuth storage requires text');
    const expiry=options.expiration??(options.expirationTtl?Math.floor(Date.now()/1000)+options.expirationTtl:null);
    await this.db.batch([this.db.prepare('INSERT INTO mcp_oauth_store (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').bind(key,value,expiry)]);
  }
  async delete(key:string) {await this.db.batch([this.db.prepare('DELETE FROM mcp_oauth_store WHERE key=?').bind(key)]);}
  async list(options:any={}) {
    const limit=Math.min(Math.max(Number(options.limit)||1000,1),1000),prefix=options.prefix??'';
    const after=options.cursor?atob(options.cursor):'';
    const rows=(await this.db.prepare('SELECT key,expires_at FROM mcp_oauth_store WHERE key>=? AND key<? AND key>? AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT ?').bind(prefix,prefix+'\uffff',after,Math.floor(Date.now()/1000),limit+1).all()).results;
    const page=rows.slice(0,limit),complete=rows.length<=limit;
    return {keys:page.map((r:any)=>({name:r.key,...(r.expires_at?{expiration:r.expires_at}:{})})),list_complete:complete,...(!complete?{cursor:btoa(page.at(-1).key)}:{})};
  }
}
