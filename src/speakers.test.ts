import {describe,it,expect} from 'vitest';
import {speakerStats,mergeSpeaker,speakingTime,speakerPayload} from './speakers';
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
