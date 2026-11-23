import {describe,it,expect} from 'vitest';
import {speakerStats,mergeSpeaker,speakingTime,speakerPayload,speakerColor,speakerColors,slotsOf,validSlots,withSpeakerSlots} from './speakers';
import type {Project,Segment} from './types';
const rows=[{id:'a',start_ms:0,end_ms:2000,text:'',speaker:1},{id:'b',start_ms:2000,end_ms:12000,text:'',speaker:0},{id:'c',start_ms:12000,end_ms:15000,text:'',speaker:1},{id:'d',start_ms:15000,end_ms:16000,text:''}];
describe('transcript speakers',()=>{
 it('counts rows and time per speaker and samples the start of the longest row',()=>{
  expect(speakerStats(rows)).toEqual([{speaker:0,rows:1,ms:10000,sample:{start_ms:2000,end_ms:8000}},{speaker:1,rows:2,ms:5000,sample:{start_ms:12000,end_ms:15000}}]);
  expect(speakerStats([{id:'x',start_ms:0,end_ms:1000,text:''}])).toEqual([]);
 });
 it('merges one speaker into another and keeps untouched rows',()=>{
  const out=mergeSpeaker(rows,1,0);
  expect(out.map(r=>r.speaker)).toEqual([0,0,0,undefined]);expect(out[1]).toBe(rows[1]);expect(out[3]).toBe(rows[3]);
 });
 it('formats speaking time in Vietnamese',()=>{
  expect(speakingTime(42400)).toBe('42 giây');expect(speakingTime(65000)).toBe('1 phút 5 giây');expect(speakingTime(3725000)).toBe('1 giờ 2 phút');
 });
 it('builds the STT speaker fields: automatic, fixed, range or off',()=>{
  expect(speakerPayload(true,'0')).toEqual({num_speakers:null});expect(speakerPayload(true,'3')).toEqual({num_speakers:3});
  expect(speakerPayload(true,'3-4')).toEqual({min_speakers:3,max_speakers:4});expect(speakerPayload(false,'3-4')).toEqual({num_speakers:null});
 });
});
describe('speaker colours',()=>{
 it('uses one of eight slots and wraps',()=>{expect([0,1,7,8,9,17].map(speakerColor)).toEqual([0,1,7,0,1,1]);});
 it('keeps "Người N" on slot N-1 and gives other names the lowest free slot in order of first appearance',()=>{
  expect([...speakerColors(['Người 1','Người 2','Người 3'])]).toEqual([['Người 1',0],['Người 2',1],['Người 3',2]]);
  // A named speaker met first still leaves the slot a later "Người N" owns.
  expect([...speakerColors(['Lan','Người 1','Minh','Người 3'])]).toEqual([['Người 1',0],['Người 3',2],['Lan',1],['Minh',3]]);
  expect(speakerColors(['Lan','Lan']).size).toBe(1);
  // "Người 0" is not a diarized speaker: it must not take slot -1.
  expect([...speakerColors(['Người 0','Người 1'])]).toEqual([['Người 1',0],['Người 0',1]]);
 });
 it('wraps the ninth name instead of failing',()=>{const names=Array.from({length:9},(_,i)=>'Khách '+i);expect(speakerColors(names).get('Khách 8')).toBeLessThan(8);});
});
describe('speaker slots kept in the project',()=>{
 const project=(...speakers:string[]):Project=>({id:'p',name:'P',updated_at:'',revision:1,segments:speakers.map((speaker,i)=>({id:`s${i}`,speaker}) as Segment),transcript:[],dictionary:{},source_asset_id:null});
 // What mutate does: the slots of the project before the edit seed the edited one.
 const edit=(p:Project,...speakers:string[])=>withSpeakerSlots({...p,segments:project(...speakers).segments},slotsOf(p));
 const slots=(p:Project)=>p.speaker_slots;
 it('keeps a renamed speaker on its slot even when the order of first appearance changed',()=>{
  expect(Object.fromEntries(speakerColors(['Minh','Lan Anh'],{Lan:0,Minh:1}))).toEqual({Minh:1,'Lan Anh':0});
 });
 it('does not move a named speaker when "Người 2" is added before it',()=>{
  expect(Object.fromEntries(speakerColors(['Người dẫn','Người 2','Bà Tư'],{'Người dẫn':0,'Bà Tư':1}))).toEqual({'Người dẫn':0,'Bà Tư':1,'Người 2':2});
  // "Người N" still takes N-1 when it is free.
  expect(speakerColors(['Người dẫn','Người 3'],{'Người dẫn':0}).get('Người 3')).toBe(2);
 });
 it('keeps one slot while a name is typed letter by letter: "B", "Bà", "Bà Tư"',()=>{
  let p=withSpeakerSlots(project('Lan','B'));p=withSpeakerSlots(project('B','Lan'),slotsOf(p));
  expect(slots(p)).toEqual({Lan:0,B:1});
  p=edit(p,'Bà','Lan');expect(slots(p)).toEqual({Lan:0,'Bà':1});
  p=edit(p,'Bà Tư','Lan');expect(slots(p)).toEqual({Lan:0,'Bà Tư':1});
 });
 it('gives a ninth or later name the least-used slot (ties: the lowest) and keeps shared slots in place',()=>{
  const prev={A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:0,J:1};
  // A's last segment is gone and K is new: I and J keep their shared slots, K takes slot 0 (used once, the lowest of the least used).
  expect(Object.fromEntries(speakerColors([...'BCDEFGHIJK'],prev))).toEqual({B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:0,J:1,K:0});
  expect(speakerColors([...'ABCDEFGHIJ']).get('J')).toBe(1);
 });
 it('without earlier slots gives the 1.0.22 mapping for up to eight speakers',()=>{
  for(const names of [['Lan','Người 1','Minh','Người 3'],['Người dẫn','Bà Tư','Cậu Hai','Cô giáo','Người dẫn'],['Người 0','Người 1'],[...'ABCDEFGH']]){
   const old=new Map<string,number>(),used=new Set<number>();
   for(const n of names){const m=/^Người ([1-9]\d*)$/.exec(n);if(m&&!old.has(n)){old.set(n,(Number(m[1])-1)%8);used.add((Number(m[1])-1)%8);}}
   for(const n of names)if(!old.has(n)){const c=[0,1,2,3,4,5,6,7].find(i=>!used.has(i))!;old.set(n,c);used.add(c);}
   expect(speakerColors(names),names.join()).toEqual(old);
  }
 });
 it('returns the same project when the slots did not change, in any key order',()=>{
  const p={...project('Lan','Minh'),speaker_slots:{Minh:1,Lan:0}};
  expect(withSpeakerSlots(p,slotsOf(p))).toBe(p);
  const empty=project();expect(withSpeakerSlots(empty)).toBe(empty);
  expect(withSpeakerSlots(project('Lan')).speaker_slots).toEqual({Lan:0});
 });
 it('survives a JSON round trip (save and reopen)',()=>{
  const p=edit(withSpeakerSlots(project('Lan','Minh')),'Người 2','Lan','Minh'),back=JSON.parse(JSON.stringify(p)) as Project;
  expect(slots(back)).toEqual({Lan:0,Minh:1,'Người 2':2});expect(slotsOf(back)).toEqual(slots(p));expect(withSpeakerSlots(back,slotsOf(back))).toBe(back);
 });
 it('keeps only integer slots 0-7 from a stored map',()=>{
  expect(validSlots({a:-1,b:8,c:1.5,d:'2',e:null,f:3,g:0})).toEqual({f:3,g:0});
  for(const x of [{a:-1,b:8},{},null,undefined,[1],'x',7])expect(validSlots(x),JSON.stringify(x)).toBeUndefined();
  // A project with only invalid entries is shown with the order-of-appearance mapping.
  expect(slotsOf({...project('Lan','Minh'),speaker_slots:{Lan:9} as Record<string,number>})).toEqual({Lan:0,Minh:1});
  expect(slotsOf({...project('Minh','Lan'),speaker_slots:{Lan:9,Minh:3} as Record<string,number>})).toEqual({Minh:3});
  expect(Object.fromEntries(speakerColors(['Minh','Lan'],{Minh:3}))).toEqual({Minh:3,Lan:0});
 });
 it('clearing a speaker and typing a new name keeps the slot; deleting its last segment frees it; a merge keeps the survivor',()=>{
  let p=withSpeakerSlots(project('Lan','Minh','Hùng'));expect(slots(p)).toEqual({Lan:0,Minh:1,'Hùng':2});
  p=edit(p,'Lan','','Hùng');expect(slots(p)).toEqual({Lan:0,'':1,'Hùng':2});
  p=edit(p,'Lan','T','Hùng');p=edit(p,'Lan','Tú','Hùng');expect(slots(p)).toEqual({Lan:0,'Tú':1,'Hùng':2});
  p=edit(p,'Lan','Hùng');expect(slots(p)).toEqual({Lan:0,'Hùng':2});
  p=edit(p,'Lan','Hùng','Vy');expect(slots(p)?.Vy).toBe(1);
  p=edit(p,'Lan','Hùng','Vy','Tú');expect(slots(p)?.['Tú'],'re-added after its slot was freed: the lowest free slot').toBe(3);
  p=edit(p,'Lan','Hùng','Vy','Lan');expect(slots(p)).toEqual({Lan:0,'Hùng':2,Vy:1});
  p=edit(p,'Lan','Hùng','Vy','Lan','Mai');expect(slots(p)?.Mai,'the slot of the merged name is free again').toBe(3);
 });
 it('seeds an old project from what it showed, so its first edit (a move) recolours nobody',()=>{
  const cur=project('Lan','Minh','Hùng'),before=Object.fromEntries(speakerColors(['Lan','Minh','Hùng']));
  expect(cur.speaker_slots).toBeUndefined();
  const moved=withSpeakerSlots({...cur,segments:[cur.segments[1],cur.segments[0],cur.segments[2]]},slotsOf(cur));
  expect(slots(moved)).toEqual(before);
  const top=withSpeakerSlots({...moved,segments:[cur.segments[2],cur.segments[0],cur.segments[1]]},slotsOf(moved));
  expect(slots(top)).toEqual(before);
 });
});
