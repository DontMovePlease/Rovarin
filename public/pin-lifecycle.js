/* Native PIN workflows. This page never receives the DPAPI native proof. */
(() => {
  'use strict';
  const styles=document.getElementById('pinFlowStyles');
  if(styles){const enable=()=>{styles.media='all';};styles.addEventListener('load',enable,{once:true});if(styles.sheet)enable();}
  const bridge = window.chrome?.webview;
  const pendingSetup = document.querySelector('meta[name="rovarin-pin-setup"]')?.content === 'true';
  let form, message, revision, action, submitting = false, requestTimer, returnFocus;
  const post = payload => bridge.postMessage({kind:'pin-control', ...payload});
  function setMessage(text) { message.textContent = text; }
  function field(label, id, current = false) {
    const wrapper = document.createElement('label'); wrapper.className = 'pin-field';
    wrapper.textContent = label;
    const input = document.createElement('input'); input.id = id; input.name = id;
    input.type = 'password'; input.inputMode = 'numeric'; input.required = true;
    input.autocomplete = current ? 'current-password' : 'new-password';
    input.maxLength = current ? 12 : 6; input.pattern = current ? '[0-9]{6}|[0-9]{8}|[0-9]{12}' : '[0-9]{6}';
    input.spellcheck = false; input.setAttribute('aria-describedby','pinFlowMessage');
    wrapper.append(input); return wrapper;
  }
  function render(container, mode) {
    action = mode; revision = null;
    form = document.createElement('form'); form.id = 'pinFlow'; form.className = 'pin-flow';
    const heading = document.createElement('h2'); heading.textContent = mode === 'enroll' ? 'Create your PIN' : 'Change PIN';
    heading.id = 'pinFlowHeading'; container.setAttribute('aria-labelledby',heading.id); form.append(heading);
    const explanation = document.createElement('p'); explanation.textContent = mode === 'enroll' ? 'Choose six digits to protect remote access to this PC.' : 'Choose six new digits. Other devices will be signed out.'; form.append(explanation);
    if (mode === 'change') form.append(field('Current PIN','currentPin',true));
    form.append(field('New PIN','newPin'),field('Confirm PIN','confirmPin'));
    const show = document.createElement('label'); show.className = 'pin-show';
    const check = document.createElement('input'); check.type = 'checkbox';
    check.addEventListener('change',()=>form.querySelectorAll('.pin-field input').forEach(input=>input.type=check.checked?'text':'password'));
    show.append(check,document.createTextNode('Show PINs')); form.append(show);
    message = document.createElement('p'); message.id = 'pinFlowMessage'; message.className = 'pin-flow-message'; message.role = 'status'; message.setAttribute('aria-live','polite'); form.append(message);
    const buttons = document.createElement('div'); buttons.className = 'pin-flow-actions';
    if (mode === 'change') { const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.addEventListener('click',()=>{if(!submitting)container.close();}); buttons.append(cancel); }
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'login-btn'; save.textContent = mode === 'enroll' ? 'Finish Setup' : 'Save PIN'; save.disabled = true; buttons.append(save); form.append(buttons);
    form.addEventListener('submit',event=>{
      event.preventDefault(); if(submitting || !revision) return;
      const newPin = form.elements.newPin.value, confirmPin = form.elements.confirmPin.value;
      if (!/^[0-9]{6}$/.test(newPin)) { setMessage('Enter exactly six digits.'); return; }
      if (newPin !== confirmPin) { setMessage('The new PINs do not match.'); form.elements.confirmPin.focus(); return; }
      submitting = true; form.querySelectorAll('button').forEach(button=>button.disabled=true); setMessage('Saving your PIN…');
      post({action,revision,newPin,confirmPin,...(action==='change'?{currentPin:form.elements.currentPin.value}:{})});
      // Secrets live only in the current form/request, never browser storage.
      form.querySelectorAll('.pin-field input').forEach(input=>input.value='');
      clearTimeout(requestTimer); requestTimer = setTimeout(()=>{submitting=false;setMessage('No confirmation received. Reopen this screen to check the saved state.');const cancel=form.querySelector('button[type=button]');if(cancel)cancel.disabled=false;},45000);
    });
    container.append(form); post({action:'status'});
  }
  if (bridge) bridge.addEventListener('message',event=>{
    const result = event.data; if(result?.kind !== 'pin-result' || !form?.isConnected) return;
    clearTimeout(requestTimer); submitting = false;
    if (!result.success) {setMessage(result.error || 'PIN update could not be confirmed. Try again.');form.querySelectorAll('button').forEach(button=>button.disabled=false);form.querySelector('[type=submit]').disabled=!revision;return;}
    if (result.action === 'status') { revision=result.revision; form.querySelector('[type=submit]').disabled=false; form.querySelector('.pin-field input').focus();return; }
    revision=null; setMessage(result.action==='enroll'?'Your PIN is ready. Opening Rovarin…':'PIN changed. Other devices have been signed out.');
    // A non-secret receipt survives navigation; PINs never do.
    try { sessionStorage.setItem('rovarin.pin-change-notice','Your PIN was saved successfully. Other devices must sign in again.'); } catch (_) {}
    window.location.replace('/');
  });
  window.addEventListener('rovarin-change-pin',()=>{
    if (!bridge || document.getElementById('pinChangeDialog')) return;
    const dialog = document.createElement('dialog'); dialog.id='pinChangeDialog'; dialog.className='pin-change-dialog';
    returnFocus=document.activeElement; document.body.append(dialog); render(dialog,'change');
    dialog.addEventListener('cancel',event=>{if(submitting)event.preventDefault();});
    dialog.addEventListener('close',()=>{clearTimeout(requestTimer);form.querySelectorAll('input').forEach(input=>input.value='');dialog.remove();form=null;returnFocus?.focus();});
    dialog.showModal();
  });
  if (pendingSetup) {
    const card=document.querySelector('.login-card');
    for(const child of [...card.children]) if(!child.classList.contains('lock-window-controls')&&!child.classList.contains('lock-window-drag'))child.hidden=true;
    document.getElementById('pinInput').disabled=true; document.getElementById('unlockBtn').disabled=true;
    if(bridge) render(card,'enroll');
    else {const heading=document.createElement('h2');heading.textContent='Set up Rovarin on your PC';const hint=document.createElement('p');hint.textContent='Open the native Rovarin Windows app to create your PIN, then return here to sign in.';card.append(heading,hint);}
  } else if(!document.getElementById('pinInput')) {
    try { const notice=sessionStorage.getItem('rovarin.pin-change-notice');if(notice){sessionStorage.removeItem('rovarin.pin-change-notice');const banner=document.createElement('p');banner.className='pin-saved-notice';banner.role='status';banner.textContent=notice;document.querySelector('main')?.prepend(banner);} } catch (_) {}
  }
})();
