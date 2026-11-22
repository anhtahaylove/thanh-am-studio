import {describe,expect,it} from 'vitest';
import {checkWords,readingOrigin,sourceSpelling,switchOffset,takeDiff} from './domain';
// Offsets are measured from the start of speech, so switching take keeps the same place in the speech.
const r=(trim_start_ms:number,trim_end_ms:number|null,duration_ms:number)=>({trim_start_ms,trim_end_ms,duration_ms});
describe('switchOffset',()=>{
 it('keeps the same distance into the speech',()=>expect(switchOffset(800,r(500,3500,4000),r(1000,5000,6000))).toBe(800));
 it('clamps to the target take trim window',()=>expect(switchOffset(2800,r(500,3500,4000),r(0,1500,2000))).toBe(1500));
 it('clamps to the source take trim window',()=>expect(switchOffset(9000,r(500,3500,4000),r(1000,5000,6000))).toBe(3000));
 it('uses the whole take when it has no trim end',()=>expect(switchOffset(1500,r(0,null,2000),r(0,null,6000))).toBe(1500));
 it('never goes below zero or returns NaN',()=>{expect(switchOffset(-5,r(0,null,2000),r(0,null,2000))).toBe(0);expect(switchOffset(NaN,r(0,null,2000),r(0,null,2000))).toBe(0);});
 it('rounds to whole milliseconds',()=>expect(switchOffset(800.6,r(0,null,2000),r(0,null,2000))).toBe(801));
});

// 5b: the diff dialog's pure parts.
describe('checkWords',()=>{
 it('matches the worker words(): pause marks, cues and <en> tags are not words',()=>expect(checkWords('<en>do it</en> [nghỉ 0.5s] Xin chào')).toEqual(['do','it','xin','chào']));
 it('drops an emotion cue',()=>expect(checkWords('Xin [thở dài] chào')).toEqual(['xin','chào']));
});
describe('sourceSpelling',()=>{
 it('gives the script spelling in its own case',()=>{expect(sourceSpelling('Ký tên vào đây.','ký')).toBe('Ký');expect(sourceSpelling('Phát sóng VTV hôm nay','vtv')).toBe('VTV');});
 it('prefers the spelling exactly as given, since dictionary keys are case-sensitive',()=>expect(sourceSpelling('Ký tên rồi ký tiếp.','ký')).toBe('ký'));
 it('matches whole words only',()=>expect(sourceSpelling('Kýnh thưa','ký')).toBeNull());
 it('is null when a rule or the dictionary rewrote the word',()=>{expect(sourceSpelling('Nặng 12 kg.','ki lô gam')).toBeNull();expect(sourceSpelling('Họp HTX sáng nay','hợp tác xã')).toBeNull();});
 it('finds a phrase across punctuation and ignores regex characters',()=>{expect(sourceSpelling('Xin chào các bạn','chào các')).toBe('chào các');expect(sourceSpelling('Xin chào, các bạn','chào các')).toBe('chào, các');expect(sourceSpelling('a (b)','.*')).toBeNull();});
});
describe('takeDiff',()=>{
 const w=(...t:string[])=>t.map((text,i)=>({text,start_ms:i*100}));
 const marks=(d:ReturnType<typeof takeDiff>)=>d.script.filter(s=>s.mark).map(s=>`${s.word}:${s.mark}`);
 it('an extra heard word marks nothing and has an empty expected',()=>{
  const d=takeDiff('Xin chào các bạn',{model:'m',heard:'xin chào các bạn bạn',words:w('xin','chào','các','bạn','bạn'),mismatches:[{expected:'',heard:'bạn',soft:false}]});
  expect(marks(d)).toEqual([]);expect(d.mismatches).toEqual([{expected:'',heard:'bạn'}]);
 });
 it('a word nothing was heard for reads missing',()=>{
  const d=takeDiff('Xin chào các bạn',{model:'m',heard:'xin chào bạn',words:w('xin','chào','bạn'),mismatches:[{expected:'các',heard:'',soft:false}]});
  expect(marks(d)).toEqual(['các:missing']);
 });
 it('a word something else was heard for reads different',()=>{
  const d=takeDiff('Xin chào các bạn',{model:'m',heard:'xin chao các bạn',words:w('xin','chao','các','bạn'),mismatches:[{expected:'chào',heard:'chao',soft:false}]});
  expect(marks(d)).toEqual(['chào:different']);
 });
 it('a number span: every sent word of the span is marked different',()=>{
  const d=takeDiff('mười hai ki lô gam gạo',{model:'m',heard:'12 kg gạo',words:w('12','kg','gạo'),mismatches:[{expected:'mười hai ki lô gam',heard:'12 kg',soft:false}]});
  expect(marks(d)).toEqual(['mười:different','hai:different','ki:different','lô:different','gam:different']);
 });
 it('a soft mismatch is never marked, and is not listed',()=>{
  const d=takeDiff('Trời hôm nay đẹp.',{model:'m',heard:'chời hôm nay đẹp',words:w('chời','hôm','nay','đẹp'),mismatches:[{expected:'trời',heard:'chời',soft:true}]});
  expect(marks(d)).toEqual([]);expect(d.mismatches).toEqual([]);
 });
 it('keeps the script case, drops tags and marks, and lists only hard mismatches',()=>{
  const d=takeDiff('<en>Do it</en> [nghỉ 1s] Xin chào',{model:'m',heard:'do it xin chao',words:w('do','it','xin','chao'),mismatches:[{expected:'chào',heard:'chao',soft:true},{expected:'x',heard:'y',soft:false}]});
  expect(d.script.map(s=>s.word)).toEqual(['Do','it','Xin','chào']);expect(d.mismatches).toEqual([{expected:'x',heard:'y'}]);
 });
 it('without word times it aligns against the heard text',()=>{
  const d=takeDiff('Xin chào các bạn',{model:'m',heard:'Xin chào, bạn.',mismatches:[{expected:'các',heard:'',soft:false}]});expect(marks(d)).toEqual(['các:missing']);
 });
 it('a segment too long to align is shown with no marks',()=>{
  const text=Array.from({length:2100},(_,i)=>`từ${i}`).join(' '),heard=Array.from({length:2100},(_,i)=>`khác${i}`).join(' ');
  const d=takeDiff(text,{model:'m',heard,mismatches:[{expected:'từ5',heard:'khác5',soft:false}]});expect(d.script.length).toBe(2100);expect(marks(d)).toEqual([]);
 });
});
describe('readingOrigin',()=>{
 it('names the dictionary entry whose reading holds the word',()=>expect(readingOrigin('Họp HTX sáng nay.',{HTX:'hợp tác xã'},'hợp tác xã')).toEqual({kind:'dictionary',key:'HTX'}));
 it('names the stretch of script a text rule rewrote',()=>{const o=readingOrigin('Nặng 12 kg.',{},'ki lô gam');expect(o).toEqual({kind:'rule',from:'kg.'});});
 it('is null when nothing explains the word',()=>expect(readingOrigin('Xin chào.',{},'abc')).toBeNull());
});
