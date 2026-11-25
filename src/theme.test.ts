import {describe,it,expect,vi} from 'vitest';
import {applyTheme,parseTheme,readTheme} from './theme';
const root=(dataset:Record<string,string>={})=>({dataset:dataset as DOMStringMap});
describe('stored theme',()=>{
 it.each(['light','dark','contrast'])('keeps a stored %s choice',v=>expect(parseTheme(v)).toBe(v));
 it.each([null,'','system','Contrast','high','bogus'])('follows the system for %j',v=>expect(parseTheme(v)).toBe('system'));
});
describe('root theme',()=>{
 it('shows the contrast theme as dark plus data-contrast, whatever the system says',()=>{
  for(const systemDark of [true,false]){const r=root();applyTheme(r,'contrast',systemDark);expect(r.dataset).toEqual({theme:'dark',contrast:'more'});}
 });
 it.each([['dark',false,'dark'],['light',true,'light'],['system',true,'dark'],['system',false,'light']] as const)('%s with a system dark=%s shows %s and no data-contrast',(theme,systemDark,shown)=>{
  const r=root({theme:'dark',contrast:'more'});applyTheme(r,theme,systemDark);expect(r.dataset).toEqual({theme:shown});
 });
});
describe('stored theme read',()=>{
 it('follows the system when storage throws, and keeps a stored contrast choice otherwise',()=>{
  vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('denied');}});expect(readTheme()).toBe('system');
  vi.stubGlobal('localStorage',{getItem:(k:string)=>k==='thanh-am-theme'?'contrast':null});expect(readTheme()).toBe('contrast');
  vi.unstubAllGlobals();
 });
});
