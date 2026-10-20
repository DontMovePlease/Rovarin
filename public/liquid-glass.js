import { vertexShader, backdropFragment, glassFragment } from './liquid-shaders.js';
const KEY='rovarin.graphicsQuality';
const SURFACES='.health-card,.metric-card,.system-specs-card,.pc-details-footer,.cpu-detail-panel,.maint-section,.power-section,.diagnostics-page,.app-page.processes-page,.login-card,.app-sidebar,.native-app-bar,.glass-panel,.glass-card';
const MODES=['auto','full','balanced','minimal'];
const root=document.documentElement;
const motion=matchMedia('(prefers-reduced-motion: reduce)');
const contrast=matchMedia('(prefers-contrast: more)');
const transparency=matchMedia('(prefers-reduced-transparency: reduce)');
const forced=matchMedia('(forced-colors: active)');
const narrow=matchMedia('(max-width: 699px)');
let library;
export class GlassRenderer {
 constructor(THREE,{calibration=false}={}) {
  this.T=THREE;this.calibration=calibration;this.frames=0;this.lastMs=0;this.totalMs=0;this.maxMs=0;this.idle=true;this.pointer={x:0,y:0,tx:0,ty:0};this.press=0;this.targetPress=0;this.phase=0;this.refraction=1;this.meshes=[];this.listeners=[];this.dead=false;this.lost=false;this.nativeVisible=true;
  this.renderer=new THREE.WebGLRenderer({alpha:true,antialias:false,powerPreference:'low-power',depth:false,stencil:false});
  this.renderer.debug.onShaderError=()=>{throw new Error('Liquid Glass shader compilation failed');};
  this.gl=this.renderer.getContext();this.maxDimension=Math.min(this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE));this.timerExtension=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');this.gpuSamples=0;this.gpuTotalMs=0;this.gpuMaxMs=0;this.queries=[];
  this.canvas=this.renderer.domElement;this.canvas.className='liquid-scene';this.canvas.setAttribute('aria-hidden','true');this.canvas.setAttribute('role','presentation');document.body.prepend(this.canvas);
  this.geometry=new THREE.PlaneGeometry(1,1);this.camera=new THREE.OrthographicCamera(0,1,1,0,-1,1);
  this.backdrop=new THREE.Scene();this.scene=new THREE.Scene();
  this.backgroundMaterial=new THREE.ShaderMaterial({vertexShader,fragmentShader:backdropFragment,depthTest:false,depthWrite:false,uniforms:{uResolution:{value:new THREE.Vector2(1,1)},uViewport:{value:new THREE.Vector2(1,1)},uPhase:{value:0},uCalibration:{value:calibration?1:0}}});
  this.background=new THREE.Mesh(this.geometry,this.backgroundMaterial);this.backdrop.add(this.background);
  this.target=new THREE.WebGLRenderTarget(1,1,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false,stencilBuffer:false});
  this.presentScene=new THREE.Scene();this.presentMaterial=new THREE.ShaderMaterial({vertexShader,fragmentShader:'varying vec2 vUv;uniform sampler2D uBackdrop;void main(){gl_FragColor=texture2D(uBackdrop,vUv);}',depthTest:false,depthWrite:false,uniforms:{uBackdrop:{value:this.target.texture}}});this.present=new THREE.Mesh(this.geometry,this.presentMaterial);this.presentScene.add(this.present);
  this.renderer.autoClear=false;this.mode='balanced';this.dirty=true;this.backdropDirty=true;
  this.on(window,'resize',()=>this.invalidate(0));this.on(window,'orientationchange',()=>this.invalidate(0));
  this.on(window.visualViewport,'resize',()=>this.invalidate(0));
  this.on(window.visualViewport,'scroll',()=>{if(!this.pageMounted)this.invalidate(0);});
  // Geometry travels with the page; only backdrop sampling follows scrolling.
  // The wallpaper itself is a fixed cached image from this same renderer.
  this.on(document,'scroll',e=>{if(this.pageMounted){if(e.target===document||e.target===document.body||e.target===root){this.wake(0);return;}if(!e.target.querySelector?.(SURFACES))return;}this.invalidate(0);},{capture:true,passive:true});
  this.on(document,'transitionrun',e=>{if(this.pageMounted&&e.target.matches?.('.phone-page-surface')&&e.propertyName==='transform'){this.phoneMotionUntil=performance.now()+(motion.matches?0:380);this.wake(motion.matches?0:380);}});
  const settled=e=>{if(e.target.matches?.('.phone-page-surface')&&e.propertyName==='transform')this.phoneMotionUntil=0;if(e.target.matches?.('.phone-page-surface,.app-sidebar,.dashboard-container'))this.pageMounted?this.wake(0):this.invalidate(0);};
  this.on(document,'transitionend',settled);this.on(document,'transitioncancel',settled);
  this.on(window,'pc-monitor-pagechange',()=>this.invalidate(0));
  this.on(document,'pointermove',e=>{if(this.mode!=='full'||motion.matches||e.pointerType==='touch')return;this.setPointer(e);this.wake(420);},{passive:true});
  this.on(document,'pointerdown',e=>{if(motion.matches||e.target.closest('.sidebar-backdrop')||!e.target.closest('button,a,summary'))return;this.setPointer(e);this.targetPress=1;this.wake(260);},{passive:true});
  this.on(window,'pointerup',()=>{if(this.targetPress===0)return;this.targetPress=0;this.wake(motion.matches?0:300);},{passive:true});
  this.on(window,'pointercancel',()=>{if(this.targetPress===0)return;this.targetPress=0;this.wake(0);},{passive:true});
  this.on(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(this.raf);this.raf=0;this.idle=true;}else this.invalidate(0);});
  this.on(window,'pc-monitor-desktop-visibility',e=>{if(typeof e.detail?.visible!=='boolean')return;this.nativeVisible=e.detail.visible;if(!this.nativeVisible){cancelAnimationFrame(this.raf);this.raf=0;this.idle=true;}else this.invalidate(0);});
  this.on(this.canvas,'webglcontextlost',e=>{e.preventDefault();this.lost=true;this.queries=[];cancelAnimationFrame(this.raf);this.raf=0;root.classList.remove('liquid-ready');report('Graphics paused. Restoring the display…');});
  this.on(this.canvas,'webglcontextrestored',()=>{this.lost=false;this.timerExtension=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');this.backdropDirty=true;this.invalidate(0);report();});
  this.observer=new MutationObserver(records=>{if(this.pageMounted&&records.every(r=>r.type==='attributes'&&r.target===document.body)){this.wake(0);return;}if(records.some(r=>r.type==='attributes'?(r.attributeName==='hidden'||r.attributeName==='open'||r.target.matches('body,.app-page,.cpu-detail-panel,.app-sidebar')):Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(n=>n.nodeType===1&&(n.matches?.(SURFACES)||n.querySelector?.(SURFACES))))){this.invalidate(this.pageMounted||motion.matches?0:360);}});
  this.observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','style','open']});
  this.resizeObserver=new ResizeObserver(()=>this.invalidate(0));this.resizeObserver.observe(document.body);
 }
 on(target,type,handler,options){if(!target)return;target.addEventListener(type,handler,options);this.listeners.push(()=>target.removeEventListener(type,handler,options));}
 setMode(mode){this.mode=mode;this.invalidate(0);}
 phoneGraphics(){return narrow.matches&&!root.classList.contains('native-shell');}
 setPointer(e){const r=this.pageMounted?.getBoundingClientRect();this.pointer.tx=e.clientX-(r?.left||0);this.pointer.ty=this.height-(e.clientY-(r?.top||0));}
 invalidate(duration=0){this.dirty=true;this.layoutUntil=performance.now()+duration;this.wake(duration);}
 wake(duration=0){if(this.dead||this.lost||document.hidden||!this.nativeVisible)return;this.until=Math.max(this.until||0,performance.now()+duration);if(!this.raf){this.idle=false;this.raf=requestAnimationFrame(t=>this.frame(t));}}
 wallpaperSize(w){
  if(this.pageMounted&&this.wallpaperWidth===w&&this.wallpaperHeight>=innerHeight)return this.wallpaperHeight;
  let height=innerHeight;
  if(this.pageMounted&&CSS.supports('height','100lvh')){const probe=document.createElement('div');probe.style.cssText='position:fixed;height:100lvh;width:0;visibility:hidden;pointer-events:none';document.body.append(probe);height=Math.max(height,probe.getBoundingClientRect().height);probe.remove();}
  return Math.max(1,Math.round(height));
 }
 publishWallpaper(){
  const ticket=this.wallpaperGeneration=(this.wallpaperGeneration||0)+1,w=this.target.width,h=this.target.height,pixels=new Uint8Array(w*h*4);
  this.renderer.readRenderTargetPixels(this.target,0,0,w,h,pixels);
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d'),image=ctx.createImageData(w,h),row=w*4;
  for(let y=0;y<h;y++)image.data.set(pixels.subarray((h-1-y)*row,(h-y)*row),y*row);
  ctx.putImageData(image,0,0);
  canvas.toBlob(blob=>{canvas.width=canvas.height=0;if(!blob||this.dead||ticket!==this.wallpaperGeneration)return;const reader=new FileReader();reader.onload=()=>{if(this.dead||ticket!==this.wallpaperGeneration)return;const picture=new Image();picture.src=reader.result;picture.decode().then(()=>{if(this.dead||ticket!==this.wallpaperGeneration)return;root.style.setProperty('--liquid-wallpaper','url("'+reader.result+'")');this.wallpaperReady=true;}).catch(()=>{});};reader.readAsDataURL(blob);},'image/png');
 }
 sampleBackdrop(){
  const r=this.pageMounted?.getBoundingClientRect(),x=r?.left||0,y=r?this.wallpaperHeight-r.top-this.height:0;
  for(const mesh of this.meshes){const u=mesh.material.uniforms;u.uBackdropSize.value.set(this.wallpaperWidth,this.wallpaperHeight);u.uBackdropOffset.value.set(x,y);}
  this.backdropOffset={x,y};
 }
 sync(){
  const T=this.T,page=this.phoneGraphics()?document.querySelector('.phone-page-surface'):null;
  if((page||null)!==(this.pageMounted||null)){this.pageMounted=page;this.canvas.classList.toggle('liquid-scene-page',!!page);(page||document.body).prepend(this.canvas);this.backdropDirty=true;this.wallpaperWidth=0;}
  const origin=page?.getBoundingClientRect();
  const w=Math.max(1,page?page.clientWidth:innerWidth),h=Math.max(1,page?Math.ceil(page.clientHeight):innerHeight);
  // Cap both total pixels and GPU texture dimensions, even for a long page.
  const requested=Math.min(devicePixelRatio||1,this.mode==='full'?1.5:1)*(this.mode==='balanced'?.75:1);
  const scale=page?Math.min(requested,Math.sqrt(2000000/(w*h)),(this.maxDimension-1)/w,(this.maxDimension-1)/h):requested;
  if(w!==this.width||h!==this.height||scale!==this.scale){this.width=w;this.height=h;this.scale=scale;this.renderer.setPixelRatio(scale);this.renderer.setSize(w,h,false);this.camera.right=w;this.camera.top=h;this.camera.updateProjectionMatrix();this.background.position.set(w/2,h/2,0);this.background.scale.set(w,h,1);this.present.position.copy(this.background.position);this.present.scale.copy(this.background.scale);}
  const wallpaperHeight=this.wallpaperSize(w),backdropScale=Math.min(requested,Math.sqrt(2000000/(w*wallpaperHeight)),(this.maxDimension-1)/w,(this.maxDimension-1)/wallpaperHeight),bw=Math.max(1,Math.floor(w*backdropScale)),bh=Math.max(1,Math.floor(wallpaperHeight*backdropScale));
  if(this.wallpaperWidth!==w||this.wallpaperHeight!==wallpaperHeight||this.target.width!==bw||this.target.height!==bh){this.wallpaperWidth=w;this.wallpaperHeight=wallpaperHeight;this.target.setSize(bw,bh);this.backgroundMaterial.uniforms.uViewport.value.set(w,wallpaperHeight);this.backgroundMaterial.uniforms.uResolution.value.set(w,wallpaperHeight);this.backdropDirty=true;}
  const bounds=el=>{const r=el.getBoundingClientRect();return{left:r.left-(origin?.left||0),top:r.top-(origin?.top||0),bottom:r.bottom-(origin?.top||0),right:r.right-(origin?.left||0),width:r.width,height:r.height};};
  const elements=Array.from(document.querySelectorAll(SURFACES)).filter(el=>{if(page&&(!page.contains(el)||el.closest('.phone-header')))return false;if(el.checkVisibility?.()===false)return false;const closed=el.closest('details:not([open])');if(closed&&!closed.querySelector(':scope > summary')?.contains(el))return false;const r=bounds(el);return !el.closest('[hidden]')&&r.width>1&&r.height>1&&r.bottom>0&&r.top<h&&r.right>0&&r.left<w&&getComputedStyle(el).visibility!=='hidden';}).slice(0,24);
  // Chrome composites last. Only a bounded set of large surfaces receives optics.
  elements.sort((a,b)=>Number(a.matches('.native-app-bar,.app-sidebar'))-Number(b.matches('.native-app-bar,.app-sidebar')));
  for(let i=0;i<elements.length;i++){
   let mesh=this.meshes[i];if(!mesh){const material=new T.ShaderMaterial({vertexShader,fragmentShader:glassFragment,depthTest:false,depthWrite:false,uniforms:{uBackdrop:{value:this.target.texture},uResolution:{value:new T.Vector2()},uBackdropSize:{value:new T.Vector2()},uBackdropOffset:{value:new T.Vector2()},uSize:{value:new T.Vector2()},uRect:{value:new T.Vector4()},uPointer:{value:new T.Vector2()},uRadius:{value:24},uRefraction:{value:1},uFull:{value:0},uPress:{value:0}}});mesh=new T.Mesh(this.geometry,material);mesh.renderOrder=i;this.meshes.push(mesh);this.scene.add(mesh);}
   const el=elements[i],r=bounds(el),u=mesh.material.uniforms;mesh.visible=true;mesh.position.set(r.left+r.width/2,h-r.top-r.height/2,0);mesh.scale.set(r.width,r.height,1);u.uResolution.value.set(w,h);u.uSize.value.set(r.width,r.height);u.uRect.value.set(r.left,h-r.bottom,r.width,r.height);u.uRadius.value=parseFloat(getComputedStyle(el).borderTopLeftRadius)||0;u.uFull.value=this.mode==='full'?1:0;u.uRefraction.value=this.refraction;
  }
  for(let i=elements.length;i<this.meshes.length;i++)this.meshes[i].visible=false;this.visibleSurfaces=elements.length;this.sidebarSurface=elements.some(el=>el.id==='appSidebar');this.dirty=false;
 }
 frame(time){this.raf=0;if(this.dead||this.lost||document.hidden||!this.nativeVisible){this.idle=true;return;}
  // Drawer motion follows the display cadence; a throttled optical frame trails its CSS parent.
  const phoneMotion=this.pageMounted&&(document.body.classList.contains('phone-drawer-dragging')||time<(this.phoneMotionUntil||0));const interval=phoneMotion?0:(this.mode==='full'?1000/60:1000/30);if(time-(this.lastFrame||0)<interval){this.raf=requestAnimationFrame(t=>this.frame(t));return;}this.lastFrame=time;
  const begin=performance.now();let query=null,queryActive=false;
  try{
  if(this.timerExtension){const gl=this.gl;while(this.queries.length&&gl.getQueryParameter(this.queries[0],gl.QUERY_RESULT_AVAILABLE)){const query=this.queries.shift();if(!gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT)){const ms=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;this.gpuTotalMs+=ms;this.gpuSamples++;this.gpuMaxMs=Math.max(this.gpuMaxMs,ms);}gl.deleteQuery(query);}}
  query=this.timerExtension&&this.queries.length<4?this.gl.createQuery():null;
  if(query){this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT,query);queryActive=true;}
  if(this.dirty||time<this.layoutUntil)this.sync();
  const dt=Math.min(.033,Math.max(.008,(time-(this.springTime||time-16))/1000));this.springTime=time;
  for(const axis of ['x','y']){const velocity='v'+axis;this.pointer[velocity]||=0;this.pointer[velocity]+=((this.pointer['t'+axis]-this.pointer[axis])*190-this.pointer[velocity]*26)*dt;this.pointer[axis]+=this.pointer[velocity]*dt;}
  this.pressVelocity||=0;this.pressVelocity+=((this.targetPress-this.press)*190-this.pressVelocity*26)*dt;this.press+=this.pressVelocity*dt;
  for(const mesh of this.meshes){mesh.material.uniforms.uPointer.value.set(this.pointer.x,this.pointer.y);mesh.material.uniforms.uPress.value=this.press;}
  this.sampleBackdrop();
  if(this.backdropDirty){this.backgroundMaterial.uniforms.uPhase.value=this.phase;this.renderer.setRenderTarget(this.target);this.renderer.clear();this.renderer.render(this.backdrop,this.camera);if(this.pageMounted)this.publishWallpaper();this.backdropDirty=false;}
   this.renderer.setRenderTarget(null);this.renderer.clear();if(!this.pageMounted)this.renderer.render(this.presentScene,this.camera);this.renderer.render(this.scene,this.camera);root.classList.add('liquid-ready');
  
  if(query){this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);queryActive=false;this.queries.push(query);query=null;}
  }catch{if(query){try{if(queryActive)this.gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);this.gl.deleteQuery(query);}catch{}}this.dispose();this.mode='minimal';root.dataset.graphicsQuality='minimal';report('Advanced graphics unavailable. Minimal appearance is active.');return;}
  this.frames++;this.lastMs=performance.now()-begin;this.totalMs+=this.lastMs;this.maxMs=Math.max(this.maxMs,this.lastMs);
  // Automatic quality responds to sustained expensive submissions, never adds idle work.
  if(preference==='auto'&&this.frames>12&&(this.totalMs/this.frames>20||(this.gpuSamples>8&&this.gpuTotalMs/this.gpuSamples>18))&&this.mode==='full'){this.setMode('balanced');root.dataset.graphicsQuality='balanced';report();}
  if(preference==='auto'&&this.mode==='balanced'&&this.gpuSamples>16&&this.gpuTotalMs/this.gpuSamples>30){this.dispose();this.mode='minimal';root.dataset.graphicsQuality='minimal';report('Minimal appearance selected for smoother performance.');return;}
  if(time<this.until&&!motion.matches)this.wake(0);else if(!this.raf)this.idle=true;
 }
 calibrationFrame(phase,refraction=1){this.phase=phase;this.refraction=refraction;this.backdropDirty=true;this.invalidate(0);}
 diagnostics(){return {quality:this.mode,frames:this.frames,idle:this.idle,contexts:this.dead?0:1,surfaces:this.visibleSurfaces||0,opticsSuspended:false,coordinateSpace:this.pageMounted?'page':'viewport',wallpaperReady:!!this.wallpaperReady,wallpaperWidth:this.wallpaperWidth,wallpaperHeight:this.wallpaperHeight,backdropOffset:this.backdropOffset,height:this.height,sidebarSurface:!!this.sidebarSurface,renderScale:this.scale,meanSubmissionMs:this.frames?this.totalMs/this.frames:0,maxSubmissionMs:this.maxMs,textureBytes:this.target.width*this.target.height*4,lost:this.lost,gpuTimerAvailable:!!this.timerExtension,gpuMeanMs:this.gpuSamples?this.gpuTotalMs/this.gpuSamples:null,gpuMaxMs:this.gpuSamples?this.gpuMaxMs:null};}
 dispose(){if(this.dead)return;this.dead=true;this.wallpaperGeneration=(this.wallpaperGeneration||0)+1;root.style.removeProperty('--liquid-wallpaper');cancelAnimationFrame(this.raf);this.raf=0;this.observer.disconnect();this.resizeObserver.disconnect();this.listeners.forEach(remove=>remove());this.meshes.forEach(mesh=>mesh.material.dispose());this.geometry.dispose();this.backgroundMaterial.dispose();this.presentMaterial.dispose();this.target.dispose();this.queries.forEach(query=>this.gl.deleteQuery(query));this.queries=[];this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();root.classList.remove('liquid-ready');this.idle=true;}
}
let preference='auto',engine=null,generation=0;
try{const saved=localStorage.getItem(KEY);if(MODES.includes(saved))preference=saved;}catch{}
function desired(){if(forced.matches||contrast.matches||transparency.matches)return 'minimal';if(preference!=='auto')return preference;if(motion.matches||navigator.connection?.saveData)return 'minimal';return narrow.matches||(navigator.deviceMemory&&navigator.deviceMemory<=4)?'balanced':'full';}
function report(message){const status=document.getElementById('graphicsQualityStatus');if(status)status.textContent=message||({full:'Full optics · renders on interaction, rests when idle.',balanced:'Balanced optics · lower resolution, no ambient animation.',minimal:'Minimal · crisp CSS surfaces, no graphics renderer.'}[root.dataset.graphicsQuality]||'Preparing graphics…');}
async function applyQuality(){const ticket=++generation,mode=desired();root.dataset.graphicsQuality=mode;const select=document.getElementById('graphicsQuality');if(select)select.value=preference;
 if(mode==='minimal'){engine?.dispose();engine=null;report();return;}
 try{library ||= import('./three-glass.module.js');const THREE=await library;if(ticket!==generation)return;if(!engine||engine.dead){engine=new GlassRenderer(THREE);}engine.setMode(mode);report();}catch{engine?.dispose();engine=null;root.dataset.graphicsQuality='minimal';report('Advanced graphics unavailable. Minimal appearance is active.');}
}
function setQuality(value){if(!MODES.includes(value))return;preference=value;try{localStorage.setItem(KEY,value);}catch{}applyQuality();}
if(root.classList.contains('liquid-theme')){
 document.getElementById('graphicsQuality')?.addEventListener('change',e=>setQuality(e.target.value));
 for(const query of [motion,contrast,transparency,forced,narrow])query.addEventListener('change',applyQuality);
 window.addEventListener('pagehide',()=>{generation++;engine?.dispose();engine=null;});window.addEventListener('pageshow',applyQuality);
 window.RovarinGlass=Object.freeze({setQuality,diagnostics:()=>engine?.diagnostics()||{quality:'minimal',frames:0,idle:true,contexts:0}});
 applyQuality();
}
