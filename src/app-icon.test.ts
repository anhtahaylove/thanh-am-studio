import {describe,it,expect} from 'vitest';
import conf from '../src-tauri/tauri.conf.json';
// The app exe (window, taskbar, Start menu, Explorer) and the setup exe take their icon from icon.ico. Its 16-48 px entries are
// hinted by hand (src-tauri/icons/source); `npx tauri icon` would replace the file with fewer, unhinted sizes.
// src is type-checked without Node's types, so the file is read with an untyped fs import.
const {readFileSync}=await import(/* @vite-ignore */ 'node:'+'fs') as {readFileSync:(path:URL)=>Uint8Array};
const bytes=readFileSync(new URL('../src-tauri/icons/icon.ico',import.meta.url));
const ico=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

describe('app icon',()=>{
 it('is the exe and installer icon',()=>{
  expect(conf.bundle.icon).toContain('icons/icon.ico');
  expect(conf.bundle.windows.nsis.installerIcon).toBe('icons/icon.ico');
 });
 it('holds every size Windows asks for, each a 32-bit PNG of its own size',()=>{
  expect([ico.getUint16(0,true),ico.getUint16(2,true)]).toEqual([0,1]);
  const entries=Array.from({length:ico.getUint16(4,true)},(_,i)=>6+16*i).map(e=>({size:ico.getUint8(e)||256,bpp:ico.getUint16(e+6,true),at:ico.getUint32(e+12,true)}));
  expect(entries.map(e=>e.size)).toEqual([16,20,24,32,40,48,64,96,128,256]);
  for(const e of entries){
   expect(e.bpp).toBe(32);
   expect(ico.getUint32(e.at)).toBe(0x89504e47);  // PNG signature
   expect([ico.getUint32(e.at+16),ico.getUint32(e.at+20)]).toEqual([e.size,e.size]);  // IHDR width and height
  }
 });
});
