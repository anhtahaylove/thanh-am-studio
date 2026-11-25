import {describe,it,expect} from 'vitest';
import {applyTheme,parseTheme} from './theme';
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
