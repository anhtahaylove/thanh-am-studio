import {describe,it,expect} from 'vitest';
// CI never runs the packaged-app harness (e2e/desktop/*.mjs), so a renamed or removed page label would only show on a Sandbox run. This reads both sides as text:
// every nav('…') name and every PAGES/pages array in the harness must be a page label of App.tsx: a title of the `pages` table, or the "Thư viện giọng" section of
// the models page. The harness `nav()` helper clicks the "Điều hướng chính" landmark, except "Dự án" (the top-bar button) and "Thư viện giọng" (Model & cài đặt, then
// that section); the sidebar itself lists four pages.
// src is type-checked without Node's types, so fs is imported untyped.
const {readFileSync,readdirSync}=await import(/* @vite-ignore */ 'node:'+'fs') as {readFileSync:(path:URL,encoding:'utf8')=>string;readdirSync:(path:URL)=>string[]};
const dir=new URL('../e2e/desktop/',import.meta.url);
const app=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
const labels=[...[...app.match(/const pages:[^\n]*/)![0].matchAll(/label:'([^']+)'/g)].map(m=>m[1]),...[...app.matchAll(/<summary>(Thư viện giọng)<\/summary>/g)].map(m=>m[1])];
const sidebar=[...app.match(/const navigation=\(\[([^\]]*)\]/)![1].matchAll(/'(\w+)'/g)].map(m=>m[1]);
const quoted=(text:string)=>[...text.matchAll(/(['"`])([^'"`$\\\n]+)\1/g)].map(m=>m[2]);
// A nav( call is a quoted name (single, double or plain template quotes) or a bare variable that walks one of the pages arrays; any other form cannot be checked, so it fails.
const LITERAL=/\bnav\(\s*(['"`])([^'"`$\\\n]+)\1\s*\)/g,VARIABLE=/\bnav\(\s*[A-Za-z_]\w*\s*\)/g,CALL=/\bnav\(/g;
const used=(text:string)=>({
 names:[...[...text.matchAll(LITERAL)].map(m=>m[2]),...[...text.matchAll(/\b(?:PAGES|pages)\s*=\s*\[([^\]]*)\]/g)].flatMap(m=>quoted(m[1]))],
 unparsed:(text.match(CALL)?.length??0)-(text.match(LITERAL)?.length??0)-(text.match(VARIABLE)?.length??0)});
const harness=readdirSync(dir).filter(f=>f.endsWith('.mjs')).map(f=>({file:f,...used(readFileSync(new URL(f,dir),'utf8'))}));

describe('desktop harness page labels',()=>{
 it('finds the navigation labels and the harness calls (so the checks below are not vacuous)',()=>{
  expect(labels.length).toBeGreaterThanOrEqual(6);expect(sidebar).toEqual(['tts','stt','models','jobs']);
  expect(harness.map(h=>h.file)).toEqual(expect.arrayContaining(['gate.mjs','packaged.mjs','textscale.mjs']));
  expect(harness.reduce((n,h)=>n+h.names.length,0)).toBeGreaterThan(20);
 });
 it('understands every nav(…) call',()=>{
  expect(harness.filter(h=>h.unparsed!==0).map(h=>h.file)).toEqual([]);
 });
 it('every nav(…) name and PAGES/pages entry exists in App.tsx',()=>{
  const missing=harness.flatMap(h=>h.names.filter(n=>!labels.includes(n)).map(n=>`${h.file}: ${n}`));
  expect(missing).toEqual([]);
 });
});
