import {describe,it,expect} from 'vitest';
import {speakerStats,mergeSpeaker,speakingTime,speakerPayload,speakerColor,speakerColors} from './speakers';
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
 });
 it('wraps the ninth name instead of failing',()=>{const names=Array.from({length:9},(_,i)=>'Khách '+i);expect(speakerColors(names).get('Khách 8')).toBeLessThan(8);});
});

