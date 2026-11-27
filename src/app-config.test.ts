import {describe,it,expect} from 'vitest';
import conf from '../src-tauri/tauri.conf.json';
// productName names the install folder, its registry keys, the Start Menu shortcut and the updater's temp copies, where a
// non-ASCII name breaks tools that read paths through the ANSI code page; the window title keeps the Vietnamese name.
describe('app config',()=>{
 it('has an ASCII product name and keeps the accented window title',()=>{
  expect(conf.productName).toBe('Thanh Am Studio');
  expect(conf.app.windows[0].title).toBe('Thanh Âm Studio');
 });
});
