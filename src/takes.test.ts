import {describe,expect,it} from 'vitest';
import {checkWords,karaokeAt,karaokeParts,readingOrigin,sourceSpelling,switchOffset,takeDiff} from './domain';
import {clampTrim} from './audio';
import {validateRecipe} from './domain';
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
// Karaoke: the script words of a playing take with the heard word times, the text between them plain.
describe('karaokeParts',()=>{
 const w=(...t:[string,number][])=>t.map(([text,start_ms])=>({text,start_ms}));
 const words=(parts:ReturnType<typeof karaokeParts>)=>parts.filter(p=>p.start_ms!==undefined);
 it('an exact match times every word, and the parts spell the text',()=>{
  const parts=karaokeParts('Xin chào, bạn.',w(['xin',0],['chào',400],['bạn',800]));
  expect(parts).toEqual([{text:'Xin',start_ms:0},{text:' '},{text:'chào',start_ms:400},{text:', '},{text:'bạn',start_ms:800},{text:'.'}]);
  expect(parts.map(p=>p.text).join('')).toBe('Xin chào, bạn.');
 });
 it('an unmatched "12" has no start, and the word before it stays lit',()=>{
  const parts=karaokeParts('Tôi có 12 quả cam',w(['tôi',0],['có',200],['mười',400],['hai',600],['quả',800],['cam',1000]));
  expect(words(parts).map(p=>[p.text,p.start_ms])).toEqual([['Tôi',0],['có',200],['12',null],['quả',800],['cam',1000]]);
  expect(parts[karaokeAt(parts,700)].text).toBe('có');expect(parts[karaokeAt(parts,800)].text).toBe('quả');expect(karaokeAt(parts,-1)).toBe(-1);
 });
 it('drops <en> tags and pause marks, and its words are the checkWords of the text',()=>{
  const text='<en>Do it</en> [nghỉ 0.5s] Xin [thở dài] chào',parts=karaokeParts(text,w(['do',0],['it',300],['xin',900],['chào',1200]));
  expect(words(parts).map(p=>p.text.toLowerCase())).toEqual(checkWords(text));expect(words(parts).map(p=>p.start_ms)).toEqual([0,300,900,1200]);
  expect(parts.map(p=>p.text).join('')).not.toMatch(/[<>[\]]|nghỉ|thở/);
 });
 it('punctuation is plain text, never a word',()=>{
  const parts=karaokeParts('“Ừ… được!” — anh nói.',w(['ừ',0],['được',300],['anh',600],['nói',900]));
  expect(words(parts).map(p=>p.text)).toEqual(['Ừ','được','anh','nói']);
  expect(parts.filter(p=>p.start_ms===undefined).map(p=>p.text)).toEqual(['“','… ','!” — ',' ','.']);
 });
 it('a segment too long to align gives every word no start',()=>{
  const text=Array.from({length:2100},(_,i)=>`từ${i}`).join(' '),parts=karaokeParts(text,Array.from({length:2100},(_,i)=>({text:`từ${i}`,start_ms:i*10})));
  expect(words(parts)).toHaveLength(2100);expect(words(parts).every(p=>p.start_ms===null)).toBe(true);expect(karaokeAt(parts,99999)).toBe(-1);
 });
});

// A3: a trim handle's value, clamped inside the take with the fades plus 50 ms between the edges; an end at the take's end is stored as null.
describe('clampTrim',()=>{
 const seg=(trim_start_ms:number,trim_end_ms:number|null,fade_in_ms=0,fade_out_ms=0)=>({trim_start_ms,trim_end_ms,fade_in_ms,fade_out_ms}),take={duration_ms:4000};
 it('keeps the start between 0 and 50 ms before the end',()=>{
  expect(clampTrim(seg(500,3500),take,'start',-200)).toEqual({trim_start_ms:0});
  expect(clampTrim(seg(500,3500),take,'start',1234.4)).toEqual({trim_start_ms:1234});
  expect(clampTrim(seg(500,3500),take,'start',9999)).toEqual({trim_start_ms:3450});
  expect(clampTrim(seg(500,null),take,'start',Infinity)).toEqual({trim_start_ms:3950});
 });
 it('keeps the end between 50 ms after the start and the take end, which is stored as null',()=>{
  expect(clampTrim(seg(500,3500),take,'end',100)).toEqual({trim_end_ms:550});
  expect(clampTrim(seg(500,3500),take,'end',2800.6)).toEqual({trim_end_ms:2801});
  expect(clampTrim(seg(500,3500),take,'end',4000)).toEqual({trim_end_ms:null});
  expect(clampTrim(seg(500,3500),take,'end',3999.6)).toEqual({trim_end_ms:null});
  expect(clampTrim(seg(500,null),take,'end',-Infinity)).toEqual({trim_end_ms:550});
 });
 it('leaves room for the fades, so the store and the render never see end <= start or fades longer than the clip',()=>{
  expect(clampTrim(seg(0,2000,300,200),take,'start',1900)).toEqual({trim_start_ms:1450});
  expect(clampTrim(seg(1000,null,300,200),take,'end',1000)).toEqual({trim_end_ms:1550});
  for(const ms of [-1e9,0,700,1449,1450,1451,5000,1e9]){const p=clampTrim(seg(0,2000,300,200),take,'start',ms),r={...seg(0,2000,300,200),...p,duration_ms:4000,gap_ms:0,gain_db:0};expect(()=>validateRecipe(r)).not.toThrow();}
 });
 it('never leaves the take, even when the fades do not fit in it',()=>{
  expect(clampTrim(seg(0,null,3000,2000),take,'start',800)).toEqual({trim_start_ms:0});
  expect(clampTrim(seg(0,null,3000,2000),take,'end',800)).toEqual({trim_end_ms:null});
 });
 it('changes nothing for a take without a usable length or an `ms` that is NaN, so no NaN reaches the store',()=>{
  for(const duration_ms of [0,NaN,-1])for(const which of ['start','end'] as const)expect(clampTrim(seg(500,null),{duration_ms},which,100)).toEqual({});
  for(const which of ['start','end'] as const)expect(clampTrim(seg(500,3500),take,which,NaN)).toEqual({});
 });
});
