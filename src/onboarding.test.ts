import {describe,it,expect} from 'vitest';
import {onboardingSteps} from './Onboarding';
import type {Job,ModelInfo} from './types';
const model=(id:string,installed:boolean,name=id):ModelInfo=>({id,name,engine:'x',kind:'model',installed,revision:'r',license:'',description:''});
const job=(kind:string,status:Job['status'],payload:Record<string,unknown>={}):Job=>({id:kind+status+JSON.stringify(payload),kind,project_id:null,payload,status,progress:1,error:null,result:null,created_at:'',updated_at:''});
const base={models:[] as ModelInfo[],jobs:[] as Job[],hasText:false,hasTranscript:false,transcriptSaved:false,totalMb:null as number|null};
const tts=(args:Partial<typeof base>={})=>onboardingSteps('tts',{...base,...args});
const stt=(args:Partial<typeof base>={})=>onboardingSteps('stt',{...base,...args});
const done=(steps:{done:boolean}[])=>steps.map(s=>s.done);
describe('TTS checklist',()=>{
 it('names the three steps, with the VieNeu size from models.json, and has no project step',()=>{
  expect(tts().map(s=>s.title)).toEqual(['Tải VieNeu v3 Turbo (637 MB)','Tạo giọng cho đoạn đầu tiên','Lưu file audio']);
  expect(tts().map(s=>s.id)).toEqual(['model','voice','export']);
 });
 it('starts with nothing done',()=>expect(done(tts())).toEqual([false,false,false]));
 it('step 1 is done once the VieNeu model is installed, and not by another model',()=>{
  expect(done(tts({models:[model('vieneu-v3',true)]}))).toEqual([true,false,false]);
  expect(done(tts({models:[model('vieneu-v3',false),model('whisper-small',true)]}))).toEqual([false,false,false]);
 });
 it('step 1 carries the running download of its model, and no other download',()=>{
  const dl=job('model_download','running',{model_id:'vieneu-v3'});
  expect(tts({jobs:[dl]})[0].job).toBe(dl);
  expect(tts({jobs:[job('model_download','running',{model_id:'whisper-small'}),job('model_download','succeeded',{model_id:'vieneu-v3'})]})[0].job).toBeUndefined();
  expect(tts()[0].model).toBe('vieneu-v3');
 });
 it('step 2 is done by a succeeded TTS job only',()=>{
  expect(done(tts({jobs:[job('tts','succeeded')]}))).toEqual([false,true,false]);
  for(const j of [job('tts','running'),job('tts','failed'),job('tts','queued'),job('render','succeeded'),job('stt','succeeded')])expect(tts({jobs:[j]})[1].done,j.kind+j.status).toBe(j.kind==='tts'&&j.status==='succeeded');
 });
 it('step 3 is done by a succeeded export (render) job only',()=>{
  expect(done(tts({jobs:[job('render','succeeded')]}))).toEqual([false,false,true]);
  for(const j of [job('render','running'),job('render','failed'),job('render','queued'),job('tts','succeeded'),job('stt','succeeded')])expect(tts({jobs:[j]})[2].done,j.kind+j.status).toBe(false);
 });
 it('step 2 can only be started when a segment has text, the other steps always can',()=>{
  expect(tts({hasText:false}).map(s=>s.ready)).toEqual([true,false,true]);
  expect(tts({hasText:true}).map(s=>s.ready)).toEqual([true,true,true]);
 });
 it('is all done for a set-up user',()=>expect(done(tts({models:[model('vieneu-v3',true)],jobs:[job('tts','succeeded'),job('render','succeeded')]}))).toEqual([true,true,true]));
});
describe('STT checklist',()=>{
 it('names the three steps with the default Whisper model and its size',()=>{
  expect(stt({models:[model('whisper-small',false,'Whisper Small'),model('whisper-turbo',false,'Whisper Large v3 Turbo')]}).map(s=>s.title)).toEqual(['Tải Whisper Small (486 MB)','Chọn tệp âm thanh để chép lời','Lưu bản chép lời']);
  expect(stt().map(s=>s.id)).toEqual(['model','pick','save']);
 });
 it('names the model the app would select: the recommended one on a big machine, an installed one over it',()=>{
  const all=(installed:string[])=>[model('whisper-small',installed.includes('whisper-small'),'Whisper Small'),model('whisper-turbo',installed.includes('whisper-turbo'),'Whisper Large v3 Turbo')];
  expect(stt({models:all([]),totalMb:15760})[0].title).toBe('Tải Whisper Large v3 Turbo (1,6 GB)');
  expect(stt({models:all([]),totalMb:15760})[0].model).toBe('whisper-turbo');
  expect(stt({models:all(['whisper-small']),totalMb:15760})[0].model).toBe('whisper-small');
 });
 it('starts with nothing done',()=>expect(done(stt())).toEqual([false,false,false]));
 it('step 1 is done once an STT model is installed, and not by VieNeu',()=>{
  expect(done(stt({models:[model('whisper-turbo',true)]}))).toEqual([true,false,false]);
  expect(done(stt({models:[model('whisper-small',true)]}))).toEqual([true,false,false]);
  expect(done(stt({models:[model('vieneu-v3',true),model('diarization',true)]}))).toEqual([false,false,false]);
 });
 it('step 1 carries the running download of the default model',()=>{
  const dl=job('model_download','queued',{model_id:'whisper-small'});
  expect(stt({jobs:[dl]})[0].job).toBe(dl);
  expect(stt({jobs:[job('model_download','running',{model_id:'vieneu-v3'})]})[0].job).toBeUndefined();
 });
 it('step 2 is done by a succeeded STT job only',()=>{
  expect(done(stt({jobs:[job('stt','succeeded')]}))).toEqual([false,true,false]);
  for(const j of [job('stt','running'),job('stt','failed'),job('stt','queued'),job('tts','succeeded'),job('render','succeeded')])expect(stt({jobs:[j]})[1].done,j.kind+j.status).toBe(false);
 });
 it('step 3 is done once the transcript was saved, and can only be started with transcript rows',()=>{
  expect(done(stt({transcriptSaved:true}))).toEqual([false,false,true]);
  expect(stt({hasTranscript:false}).map(s=>s.ready)).toEqual([true,true,false]);
  expect(stt({hasTranscript:true}).map(s=>s.ready)).toEqual([true,true,true]);
 });
 it('is all done for a set-up user',()=>expect(done(stt({models:[model('whisper-small',true)],jobs:[job('stt','succeeded')],transcriptSaved:true}))).toEqual([true,true,true]));
 it('a TTS job does not finish an STT step and an STT job does not finish a TTS step',()=>{
  expect(done(stt({jobs:[job('tts','succeeded'),job('render','succeeded')]}))).toEqual([false,false,false]);
  expect(done(tts({jobs:[job('stt','succeeded')]}))).toEqual([false,false,false]);
 });
});
