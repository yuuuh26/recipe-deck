import {all,putAiDraft,removeAiDraft} from './db.mjs';
import {CLOUD_ORIGIN} from './cloud-api.mjs';
export const importedRecipeId=id=>'recipe_mcp_'+id;
async function api(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
  if(!response.ok)throw new Error(response.status===401?'クラウドへ接続すると受信できます':'下書きを受信できません。再確認してください。');
  return response.json();
}
export async function initDraftInbox({open,isIdle,hasRecipe,toast}) {
  let drafts=[],busy=false,lastCheck=0;
  const $=id=>document.getElementById(id),hosted=location.origin===CLOUD_ORIGIN;
  const render=message=>{
    $('aiInboxBanner').hidden=!drafts.length;
    $('aiInboxCount').textContent='AIからの下書き '+drafts.length+'件';
    $('aiInboxStatus').textContent=message??(drafts.length?drafts.length+'件の下書きが届いています':'受信待ちの下書きはありません');
    $('aiMcpUrl').textContent=CLOUD_ORIGIN+'/mcp';
  };
  const show=()=>{if(drafts.length&&isIdle())open(drafts[0]);};
  async function ack(id){
    await api('/v1/ai-drafts/'+id+'/received',{method:'POST'});
    await removeAiDraft(id);drafts=drafts.filter(d=>d.id!==id);render();
  }
  async function refresh(force=false){
    if(busy||(!force&&Date.now()-lastCheck<3000))return;
    busy=true;lastCheck=Date.now();
    try{
      drafts=(await all('aiDrafts')).filter(d=>!hasRecipe(importedRecipeId(d.id)));render();
      if(!hosted){render('MCP受信はクラウド対応版で利用できます');return;}
      const data=await api('/v1/ai-drafts');
      if(!Array.isArray(data.drafts))throw Error('受信内容を確認できません');
      const local=new Map(drafts.map(d=>[d.id,d]));
      for(const d of data.drafts){
        if(!/^[0-9a-f-]{36}$/.test(d.id)||typeof d.recipe_text!=='string'||d.recipe_text.length>20000)continue;
        if(hasRecipe(importedRecipeId(d.id))){await ack(d.id);continue;}
        if(!local.has(d.id)){const draft={id:d.id,recipeText:d.recipe_text,createdAt:d.created_at};await putAiDraft(draft);local.set(d.id,draft);}
      }
      drafts=[...local.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));render();show();
    }catch(error){render(error.message);show();}finally{busy=false;}
  }
  $('aiRefresh').addEventListener('click',()=>void refresh(true));
  $('aiOpenDraft').addEventListener('click',show);
  $('aiCopyMcp').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(CLOUD_ORIGIN+'/mcp');toast('MCP接続先をコピーしました')}catch{toast('接続先をコピーできませんでした')}});
  $('aiRevoke').addEventListener('click',async()=>{
    const key=$('cloudAdminKey').value;$('cloudAdminKey').value='';
    if(!key){toast('端末管理の本人確認用の復旧キーを入力してください');return;}
    try{await api('/v1/mcp/revoke-all',{method:'POST',headers:{Authorization:'Bearer '+key}});toast('AIの接続をすべて解除しました')}catch{toast('解除できませんでした。復旧キーと通信を確認してください')}
  });
  // No polling timer: only launch, foregrounding, connectivity and explicit refresh.
  window.addEventListener('focus',()=>void refresh());
  window.addEventListener('online',()=>void refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
  await refresh(true);
  return {refresh,ack};
}
