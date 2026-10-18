const $=id=>document.getElementById(id);
async function check(){
  try{const r=await fetch('/v1/session',{credentials:'same-origin',cache:'no-store'});const okay=r.ok;
    $('oauthLogin').hidden=okay;$('oauthApprove').disabled=!okay;
    $('oauthStatus').textContent=okay?'この端末の接続を確認しました。':'復旧キーでこの端末を接続してください。';
  }catch{$('oauthStatus').textContent='通信を確認して、接続をやり直してください。'}
}
$('oauthLogin').addEventListener('submit',async e=>{e.preventDefault();const key=$('oauthKey').value;$('oauthKey').value='';
  try{const r=await fetch('/v1/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({deviceName:'ChatGPT連携の端末'})});if(!r.ok)throw Error();await check();}catch{$('oauthStatus').textContent='接続できませんでした。復旧キーと通信を確認してください。'}
});
check();
