(() => {
  'use strict';
  const get=id=>document.getElementById(id),dialog=get('appLeftoversDialog'),offers=get('appLeftoversOffers');
  if(!dialog||!offers)return;
  const title=get('appLeftoversTitle'),summary=get('appLeftoversSummary'),folders=get('appLeftoversFolders'),excluded=get('appLeftoversExcluded'),approval=get('appLeftoversApproval'),pin=get('appLeftoversPin'),error=get('appLeftoversError'),remove=get('appLeftoversDelete'),cancel=get('appLeftoversCancel');
  let preview=null,pending=false,jobId=null,visibleJob=null,latest=null,offerSignature='';
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const size=bytes=>{if(!Number.isFinite(bytes))return '—';const units=['B','KB','MB','GB'];let u=0;while(bytes>=1024&&u<3){bytes/=1024;u++;}return (u&&bytes<10?bytes.toFixed(1):Math.round(bytes))+' '+units[u];};
  const files=count=>count+' '+(count===1?'file':'files');
  const requestStatus=()=>window.dispatchEvent(new Event('rovarin-apps-refresh-status'));
  async function post(action,body){const response=await fetch('/api/apps/leftovers/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(data.code==='pin-required')await window.RovarinRemovalSecurity.refresh();throw Error(data.error||'Cleanup could not be completed.');}return data;}
  function setPending(value){pending=value;cancel.disabled=value;remove.disabled=value;}
  function clear(){preview=null;jobId=null;visibleJob=null;pin.value='';error.textContent='';approval.hidden=true;remove.hidden=true;folders.replaceChildren();excluded.hidden=true;cancel.textContent='Cancel';}
  async function scan(id,name){if(pending||latest?.busy)return;clear();title.textContent='Scan for leftovers';summary.textContent='Checking confidently matched folders for '+name+'…';setPending(true);dialog.showModal();
    try{await window.RovarinRemovalSecurity.refresh();const data=await post('scan',{receiptId:id});preview=data.preview;title.textContent=preview.candidates.length?'Delete these leftovers?':'No eligible leftovers found';summary.textContent=preview.name+' · '+files(preview.fileCount)+' · '+size(preview.bytes)+' estimated reclaimable storage';
      for(const c of preview.candidates){const li=node('li');li.append(node('strong',c.location),node('small',c.source+' · '+files(c.fileCount)+' · '+size(c.bytes)));folders.append(li);}
      excluded.querySelector('ul').replaceChildren();for(const c of preview.excluded){const li=node('li');li.textContent=c.location+' — '+c.reason;excluded.querySelector('ul').append(li);}excluded.hidden=!preview.excluded.length;
      approval.hidden=remove.hidden=!preview.candidates.length;if(!preview.candidates.length)cancel.textContent='Close';
    }catch(e){summary.textContent='Scan could not be completed.';error.textContent=e.message;cancel.textContent='Close';}
    finally{setPending(false);requestStatus();if(preview?.candidates.length)(window.RovarinRemovalSecurity.requirePin?pin:remove).focus();}
  }
  async function dismiss(){if(pending)return;const id=preview?.id;preview=null;pin.value='';dialog.close();if(id&&!jobId)try{await post('cancel',{scanId:id});}catch(_){};}
  cancel.addEventListener('click',dismiss);dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});dialog.addEventListener('close',()=>{pin.value='';});
  get('appLeftoversForm').addEventListener('submit',async e=>{e.preventDefault();if(pending||!preview?.candidates.length||(window.RovarinRemovalSecurity.requirePin&&!/^(?:\d{6}|\d{12})$/.test(pin.value)))return;
    const body={scanId:preview.id,...(window.RovarinRemovalSecurity.requirePin?{pin:pin.value}:{}),confirmation:'delete-leftovers'};pin.value='';error.textContent='';setPending(true);
    try{const data=await post('delete',body);jobId=data.jobId;preview=null;approval.hidden=true;remove.hidden=true;title.textContent='Deleting leftovers…';summary.textContent='Rechecking every approved folder before removal.';requestStatus();}
    catch(e){setPending(false);error.textContent=e.message;pin.focus();}
  });
  function update(data,busy){if(!data)return;latest={...data,busy:busy||data.busy};
    const signature=JSON.stringify([data.offers,latest.busy]);if(signature!==offerSignature){offerSignature=signature;offers.replaceChildren();for(const offer of data.offers||[]){const row=node('div');row.append(node('span',offer.name+' was removed.'));const button=node('button','Scan for leftovers');button.type='button';button.className='processes-freeze';button.disabled=latest.busy;button.addEventListener('click',()=>scan(offer.id,offer.name));row.append(button);offers.append(row);}offers.hidden=!data.offers?.length;}
    const job=data.job;if(!jobId||!job||job.id!==jobId||!dialog.open)return;
    const signatureJob=JSON.stringify(job);if(signatureJob===visibleJob)return;visibleJob=signatureJob;
    title.textContent=job.state==='deleting'?'Deleting leftovers…':job.state==='completed'?'Cleanup complete':'Cleanup finished with skipped or failed items';
    summary.textContent=files(job.filesRemoved)+' removed · '+size(job.bytesRemoved)+' verified file space reclaimed · '+job.filesSkipped+' skipped · '+job.filesFailed+' failed'+(job.unconfirmed?' · Some results could not be verified. Scan again before retrying.':'');
    folders.replaceChildren();for(const item of job.items){const li=node('li');li.append(node('strong',item.location),node('small',item.state+(item.reason?' — '+item.reason:'')));for(const detail of item.details||[])li.append(node('small',detail.location+' — '+detail.reason.replaceAll('-',' ')));folders.append(li);}
    setPending(job.state==='deleting');cancel.textContent='Close';
  }
  window.RovarinLeftovers={update};
})();
