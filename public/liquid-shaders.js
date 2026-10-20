// The glass samples only this rendered scene, never arbitrary DOM pixels.
export const vertexShader = `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
export const backdropFragment = `
precision highp float;
varying vec2 vUv;
uniform vec2 uResolution;
uniform vec2 uViewport;
uniform float uPhase;
uniform float uCalibration;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
 vec2 uv=vUv; vec2 p=(uv-.5)*vec2(uResolution.x/uResolution.y,1.);
 if(uCalibration>.5){vec2 q=(uv+vec2(uPhase*.07,0.))*vec2(24.,18.);float grid=mod(floor(q.x)+floor(q.y),2.);gl_FragColor=vec4(mix(vec3(.03),vec3(.95,.88,.72),grid),1.);return;}
 // Static folded-satin wallpaper: clear, softly lit contours give the glass
 // a visible image to refract. No moving noise, orbit outlines or ambient loop.
 vec2 q=(vec2(uv.x*uResolution.x,(1.-uv.y)*uResolution.y)-uViewport*.5)/max(uViewport.y,1.);
 float fold=q.x*.78+sin(q.y*2.4+q.x*.55)*.32;
 float ribbon=smoothstep(-.29,-.23,fold)*(1.-smoothstep(.13,.28,fold));
 float lip=exp(-abs(fold+.23)*46.);
 float second=q.x*.68-.30*cos(q.y*1.7+.55);
 float violet=smoothstep(.03,.10,second)*(1.-smoothstep(.35,.52,second));
 vec3 col=vec3(.018,.033,.065);
 col+=vec3(.045,.19,.25)*ribbon;
 col+=vec3(.12,.27,.31)*lip*.53;
 col+=vec3(.13,.077,.225)*violet;
 col+=vec3(.055,.10,.15)*exp(-pow((fold-.12)*15.,2.));
 col+=vec3(.065,.04,.12)*exp(-pow((second-.35)*22.,2.));
 float grain=(hash(gl_FragCoord.xy)-.5)/255.;
 gl_FragColor=vec4(col+grain,1.);
}`;
export const glassFragment = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uBackdrop;
uniform vec2 uResolution;
uniform vec2 uBackdropSize;
uniform vec2 uBackdropOffset;
uniform vec2 uSize;
uniform vec4 uRect;
uniform vec2 uPointer;
uniform float uRadius;
uniform float uRefraction;
uniform float uFull;
uniform float uPress;
float roundedBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
void main(){
 vec2 size=uSize;vec2 p=(vUv-.5)*size;float radius=min(uRadius,min(size.x,size.y)*.5);
 float d=roundedBox(p,size*.5-vec2(.8),radius);
 if(d>0.)discard;
 vec2 corner=max(abs(p)-(size*.5-radius),0.);
 vec2 n=length(corner)>.01?normalize(corner)*sign(p):(abs(p.x)/(size.x*.5)>abs(p.y)/(size.y*.5)?vec2(sign(p.x),0.):vec2(0.,sign(p.y)));
 float rim=1.-smoothstep(0.,24.,-d);
 // Rounded edge normals displace screen-space UVs; the interior is a gentle lens.
 vec2 screen=(uRect.xy+vUv*uRect.zw+uBackdropOffset)/uBackdropSize;
 vec2 displacement=(n*(rim*rim*13.+uPress*rim*2.5)+p*.007)*uRefraction/uBackdropSize;
 vec2 refracted=clamp(screen-displacement,vec2(.001),vec2(.999));
 vec2 dispersion=n*rim*rim*(uFull>.5?1.5:.65)*uRefraction/uBackdropSize;
 vec3 color; color.r=texture2D(uBackdrop,refracted-dispersion).r;
 color.g=texture2D(uBackdrop,refracted).g;color.b=texture2D(uBackdrop,refracted+dispersion).b;
 if(uFull>.5){vec2 blur=vec2(1.7)/uBackdropSize;color=mix(color,(texture2D(uBackdrop,refracted+blur).rgb+texture2D(uBackdrop,refracted-blur).rgb)*.5,.19);}
 color=mix(color,vec3(.075,.11,.17),.24);
 vec2 light=normalize(uPointer-(uRect.xy+vUv*uRect.zw)+vec2(.01));
 float spec=pow(max(dot(n,light),0.),5.);
 float edge=exp(-abs(d+1.1)*1.5);
 color+=vec3(.33,.50,.59)*edge*(.22+.65*spec);
 color+=vec3(.13,.16,.24)*pow(rim,3.)*spec;
 gl_FragColor=vec4(color,1.);
}`;
