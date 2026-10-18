import {all,putAiDraft,saveImportedRecipe,hasReceivedAiDraft,markAiDraftReceived} from './db.mjs';
import {CLOUD_ORIGIN} from './cloud-api.mjs';
import {titleOf} from './model.mjs';
export const importedRecipeId=id=>'recipe_mcp_'+id;
async function api(path,options={}) {
  const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});
  if(!response.ok)throw new Error(response.status===401?'クラウドへ接続すると受信できます':'レシピを受信できません。再確認してください。');
  return response.json();
}
export async function initDraftInbox({open,isIdle,hasRecipe,received,toast}) {
  let drafts=[],busy=false,lastCheck=0;
  const $=id=>document.getElementById(id),hosted=location.origin===CLOUD_ORIGIN;
  const render=message=>{
    $('aiInboxBanner').hidden=!drafts.length;
    $('aiInboxCount').textContent='AIからの受信待ち '+drafts.length+'件';
    $('aiInboxStatus').textContent=message??(drafts.length?drafts.length+'件のレシピを受信待ちです':'受信待ちのレシピはありません');
    $('aiMcpUrl').textContent=CLOUD_ORIGIN+'/mcp';
  };
  async function ack(id){
    await api('/v1/ai-drafts/'+id+'/received',{method:'POST'});
  }
  async function refresh(force=false){
    if(busy||(!force&&Date.now()-lastCheck<3000))return;
    busy=true;lastCheck=Date.now();
    try{
      drafts=await all('aiDrafts');render();
      if(!hosted){render('MCP受信はクラウド対応版で利用できます');return;}
      const local=new Map(drafts.map(d=>[d.id,d]));
      let warning='';
      try{
        const data=await api('/v1/ai-drafts');
        if(!Array.isArray(data.drafts))throw Error('受信内容を確認できません');
        for(const d of data.drafts){
          if(!/^[0-9a-f-]{36}$/.test(d.id)||typeof d.recipe_text!=='string'||!d.recipe_text.trim()||d.recipe_text.length>20000)continue;
          if(!local.has(d.id)){const draft={id:d.id,recipeText:d.recipe_text,createdAt:d.created_at};await putAiDraft(draft);local.set(d.id,draft);}
        }
      }catch(error){warning=error.message;}
      const added=[],acknowledge=[];
      for(const d of [...local.values()].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))){
        try{
          if(!await hasReceivedAiDraft(d.id)&&!hasRecipe(importedRecipeId(d.id))){
            if(!d.recipeText?.trim())throw Error('本文が空のため受信待ちです');
            const date=d.createdAt||new Date().toISOString();
            const recipe={rating:null,tagIds:[],genre:'',notes:'',createdAt:date,updatedAt:date,...d.recipe,id:importedRecipeId(d.id),title:titleOf(d.recipeText),recipeText:d.recipeText};
            try{await saveImportedRecipe(recipe,d.id);added.push(recipe);}
            catch(error){
              // Another tab may have committed this same receipt meanwhile.
              if(!await hasReceivedAiDraft(d.id)&&!(await all('recipes')).some(r=>r.id===recipe.id))throw error;
            }
          }
          await markAiDraftReceived(d.id);
          acknowledge.push(d.id);
        }catch{warning='追加できないレシピを端末に保持しています。受信を再試行してください';}
      }
      drafts=await all('aiDrafts');
      if(added.length){
        received(added);
        if(isIdle())open(added[0]);
        toast(added.length+'件のレシピを自動追加しました');
      }
      render(warning||(added.length?added.length+'件のレシピを自動追加しました':undefined));
      // A slow receipt notification must not delay the saved recipe's display.
      for(const id of acknowledge){
        try{await ack(id);}catch{render('レシピは追加済みです。受信通知は次回再送します');}
      }
    }catch(error){render(error.message);}finally{busy=false;}
  }
  $('aiRefresh').addEventListener('click',()=>void refresh(true));
  $('aiOpenDraft').addEventListener('click',()=>void refresh(true));
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
  return {refresh};
}
