import {describe,it,expect} from 'vitest';
// The eight speaker colours must stay apart for people with a colour-vision deficiency too: CIEDE2000 on sRGB (D65) after a
// Machado, Oliveira & Fernandes 2009 simulation at severity 1.0 (applied to linear RGB), for all 28 pairs in both themes.
// Vitest stubs CSS imports and src is type-checked without Node's types, so the stylesheet is read with an untyped fs import.
const {readFileSync}=await import(/* @vite-ignore */ 'node:'+'fs') as {readFileSync:(path:URL,encoding:'utf8')=>string};
const css=readFileSync(new URL('./styles.css',import.meta.url),'utf8');
const block=(head:string)=>{const b=css.split('\n').find(l=>l.startsWith(head)&&l.includes('--spk-0:'))!,tok=(n:string)=>/#[0-9a-f]{6}/i.exec(b.split(`${n}:`)[1]??'')?.[0]??'';
 return {text:[0,1,2,3,4,5,6,7].map(n=>tok(`--spk-${n}`)),soft:[0,1,2,3,4,5,6,7].map(n=>tok(`--spk-${n}-soft`))};};
const ink=[...css.matchAll(/--ink:(#[0-9a-f]{6})/gi)].map(m=>m[1]);
const THEMES={light:{...block(':root{'),ink:ink[0]},dark:{...block('[data-theme=dark]{'),ink:ink[1]}};
const MACHADO={protan:[[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],deutan:[[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.01182,0.04294,0.968881]],tritan:[[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.3039]]};
const linear=(hex:string)=>[1,3,5].map(i=>{const x=parseInt(hex.slice(i,i+2),16)/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;});
const simulate=(rgb:number[],m:number[][])=>m.map(row=>Math.min(1,Math.max(0,row[0]*rgb[0]+row[1]*rgb[1]+row[2]*rgb[2])));
const lab=([r,g,b]:number[])=>{const f=(t:number)=>t>0.008856?Math.cbrt(t):7.787*t+16/116,[x,y,z]=[(0.4124*r+0.3576*g+0.1805*b)/0.95047,0.2126*r+0.7152*g+0.0722*b,(0.0193*r+0.1192*g+0.9505*b)/1.08883].map(f);return [116*y-16,500*(x-y),200*(y-z)];};
const de2000=([L1,a1,b1]:number[],[L2,a2,b2]:number[])=>{const rad=Math.PI/180,C7=(c:number)=>Math.sqrt(c**7/(c**7+25**7)),G=0.5*(1-C7((Math.hypot(a1,b1)+Math.hypot(a2,b2))/2));
 const [p1,p2]=[a1*(1+G),a2*(1+G)],[C1,C2]=[Math.hypot(p1,b1),Math.hypot(p2,b2)],hue=(a:number,b:number)=>(Math.atan2(b,a)/rad+360)%360,[h1,h2]=[hue(p1,b1),hue(p2,b2)];
 const dh=C1*C2===0?0:Math.abs(h2-h1)<=180?h2-h1:h2-h1>180?h2-h1-360:h2-h1+360,dH=2*Math.sqrt(C1*C2)*Math.sin(dh*rad/2),L=(L1+L2)/2,C=(C1+C2)/2;
 const H=C1*C2===0?h1+h2:Math.abs(h1-h2)<=180?(h1+h2)/2:h1+h2<360?(h1+h2+360)/2:(h1+h2-360)/2;
 const T=1-0.17*Math.cos((H-30)*rad)+0.24*Math.cos(2*H*rad)+0.32*Math.cos((3*H+6)*rad)-0.2*Math.cos((4*H-63)*rad),Rt=-Math.sin(60*Math.exp(-(((H-275)/25)**2))*rad)*2*C7(C);
 const [sL,sC,sH]=[1+0.015*(L-50)**2/Math.sqrt(20+(L-50)**2),1+0.045*C,1+0.015*C*T],[l,c,h]=[(L2-L1)/sL,(C2-C1)/sC,dH/sH];return Math.sqrt(l*l+c*c+h*h+Rt*c*h);};
const ratio=(a:string,b:string)=>{const Y=(h:string)=>{const [r,g,bl]=linear(h);return 0.2126*r+0.7152*g+0.0722*bl;},[x,y]=[Y(a),Y(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const pairs=[0,1,2,3,4,5,6,7].flatMap(i=>[0,1,2,3,4,5,6,7].filter(j=>j>i).map(j=>[i,j]));
const closest=(labs:number[][])=>pairs.map(([i,j])=>({pair:`${i}-${j}`,d:de2000(labs[i],labs[j])})).sort((p,q)=>p.d-q.d)[0];
describe('speaker palette',()=>{
 it('reads 16 colours and the ink colour per theme, and the colour maths matches published values',()=>{
  for(const t of Object.values(THEMES)){expect([...t.text,...t.soft,t.ink].every(h=>/^#[0-9a-f]{6}$/i.test(h))).toBe(true);}
  expect(de2000([50,2.6772,-79.7751],[50,0,-82.7485])).toBeCloseTo(2.0425,3);expect(de2000([50,2.5,0],[73,25,-18])).toBeCloseTo(27.1492,3); // Sharma et al. 2005 test pairs
  expect(simulate([1,1,1],MACHADO.deutan).map(v=>+v.toFixed(2)),'white stays white').toEqual([1,1,1]);
 });
 for(const [theme,t] of Object.entries(THEMES)){
  it(`every two speaker colours are at least 15 apart for normal vision and 8 apart under protan, deutan and tritan simulation, ${theme}`,()=>{
   const min=[['normal',15,closest(t.text.map(h=>lab(linear(h))))] as const,...Object.entries(MACHADO).map(([k,m])=>[k,8,closest(t.text.map(h=>lab(simulate(linear(h),m))))] as const)];
   expect(min.filter(([,floor,c])=>c.d<floor).map(([k,floor,c])=>`${k} ${c.pair} ${c.d.toFixed(1)} < ${floor}`)).toEqual([]);
  });
  it(`each speaker colour keeps 4.5:1 on its tint and stays 10 apart from the text colour, ${theme}`,()=>{
   for(const n of [0,1,2,3,4,5,6,7]){expect(ratio(t.text[n],t.soft[n]),`--spk-${n} on its tint`).toBeGreaterThanOrEqual(4.5);expect(de2000(lab(linear(t.text[n])),lab(linear(t.ink))),`--spk-${n} vs --ink`).toBeGreaterThanOrEqual(10);}
  });
 }
});
