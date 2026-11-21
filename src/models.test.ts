import {describe,it,expect} from 'vitest';
import {MODEL_RAM_MB,formatBytes,modelAdvice,modelSize} from './models';
// A 16 GB machine reports about 15,760 MB of physical memory, an 8 GB one about 7,910 MB.
const STT=['whisper-small','whisper-turbo'];
const picks=(total:number|null,ram?:Record<string,number|null>)=>STT.filter(id=>modelAdvice(id,total,ram).badge==='recommended');
describe('model sizes',()=>{
 it('sums the artifacts of models.json, and takes the pack size for the separation runtime',()=>{
  expect(modelSize('vieneu-v3')).toBe(636939541);
  expect(modelSize('separation-runtime')).toBe(173988339);
  expect(modelSize('nope')).toBeNull();
 });
 it('formats sizes the Vietnamese way',()=>{
  expect(formatBytes(636939541)).toBe('637 MB');
  expect(formatBytes(1621665983)).toBe('1,6 GB');
  expect(formatBytes(2200e6)).toBe('2,2 GB');
  expect(formatBytes(999_600_000)).toBe('1 GB');
 });
});
describe('model advice',()=>{
 it('keeps Turbo unmeasured, so Small is the only STT pick on every machine',()=>{
  expect(MODEL_RAM_MB['whisper-turbo']).toBeNull();
  for(const total of [null,3900,7910,15760,65536])expect(picks(total),String(total)).toEqual(['whisper-small']);
  expect(modelAdvice('whisper-turbo',15760)).toEqual({badge:null});
 });
 it('picks a measured Turbo alone at 15,760 MB, and not below TURBO_MIN_MB or when it does not fit',()=>{
  const measured={...MODEL_RAM_MB,'whisper-turbo':3200};
  expect(picks(15760,measured)).toEqual(['whisper-turbo']);
  expect(modelAdvice('whisper-small',15760,measured)).toEqual({badge:null,note:'Cần cho Tự kiểm bằng Whisper'});
  expect(picks(7910,measured)).toEqual(['whisper-small']);
  expect(picks(15760,{...measured,'whisper-turbo':13000})).toEqual(['whisper-small']);
  expect(picks(null,measured)).toEqual(['whisper-small']);
 });
 it('recommends VieNeu at 7,910 MB and when the memory is unknown, and calls it heavy at 3,900 MB',()=>{
  expect(modelAdvice('vieneu-v3',7910).badge).toBe('recommended');
  expect(modelAdvice('vieneu-v3',null).badge).toBe('recommended');
  const heavy=modelAdvice('vieneu-v3',3900);
  expect(heavy.badge).toBe('heavy');
  expect(heavy.note).toContain('2,2 GB');
  expect(heavy.note).toContain('3,9 GB');
 });
 it('gives diarization, HTDemucs and the pack no badge',()=>{
  for(const id of ['diarization','htdemucs','separation-runtime'])expect(modelAdvice(id,15760)).toEqual({badge:null});
 });
});
