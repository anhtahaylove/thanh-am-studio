import {describe,it,expect} from 'vitest';
// CI never runs the packaged-app harness (e2e/desktop/*.mjs), so a renamed or removed page label would only show on a Sandbox run. This reads both sides as text:
// every nav('…') name and every PAGES/pages array in the harness must be a label of the `navigation` list in App.tsx, or the top-bar "Dự án".
// src is type-checked without Node's types, so fs is imported untyped.
const {readFileSync,readdirSync}=await import(/* @vite-ignore */ 'node:'+'fs') as {readFileSync:(path:URL,encoding:'utf8')=>string;readdirSync:(path:URL)=>string[]};
const dir=new URL('../e2e/desktop/',import.meta.url);
const app=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
const labels=[...app.match(/const navigation[^\n]*/)![0].matchAll(/label:'([^']+)'/g)].map(m=>m[1]);
const TOP_BAR=['Dự án'];
const quoted=(text:string)=>[...text.matchAll(/'([^']+)'/g)].map(m=>m[1]);
const used=(text:string)=>[...[...text.matchAll(/\bnav\('([^']+)'\)/g)].map(m=>m[1]),...[...text.matchAll(/\b(?:PAGES|pages)\s*=\s*\[([^\]]*)\]/g)].flatMap(m=>quoted(m[1]))];
const harness=readdirSync(dir).filter(f=>f.endsWith('.mjs')).map(f=>({file:f,names:used(readFileSync(new URL(f,dir),'utf8'))}));

describe('desktop harness page labels',()=>{
 it('finds the navigation labels and the harness calls (so the check below is not vacuous)',()=>{
  expect(labels.length).toBeGreaterThanOrEqual(4);
  expect(harness.map(h=>h.file)).toEqual(expect.arrayContaining(['gate.mjs','packaged.mjs','textscale.mjs']));
  expect(harness.reduce((n,h)=>n+h.names.length,0)).toBeGreaterThan(20);
 });
 it('every nav(…) name and PAGES/pages entry exists in App.tsx',()=>{
  const missing=harness.flatMap(h=>h.names.filter(n=>!labels.includes(n)&&!TOP_BAR.includes(n)).map(n=>`${h.file}: ${n}`));
  expect(missing).toEqual([]);
 });
});
