import {describe,it,expect} from 'vitest';
import {onboardingSteps} from './Onboarding';
import type {Job,ModelInfo,ProjectSummary} from './types';
const model=(id:string,installed:boolean):ModelInfo=>({id,name:id,engine:'x',kind:'model',installed,revision:'r',license:'',description:''});
const project:ProjectSummary={id:'p',name:'P',updated_at:'',revision:1};
const job=(kind:string,status:Job['status']):Job=>({id:kind+status,kind,project_id:null,payload:{},status,progress:1,error:null,result:null,created_at:'',updated_at:''});
const done=(args:Partial<Parameters<typeof onboardingSteps>[0]>)=>onboardingSteps({models:[],projects:[],jobs:[],hasText:false,...args}).map(s=>s.done);
describe('onboarding steps',()=>{
 it('names the three steps, with the VieNeu size from models.json',()=>{
  expect(onboardingSteps({models:[],projects:[],jobs:[],hasText:false}).map(s=>s.title)).toEqual(['Tải VieNeu v3 Turbo (637 MB)','Tạo hoặc mở một dự án','Tạo giọng cho đoạn đầu tiên']);
 });
 it('starts with nothing done',()=>expect(done({})).toEqual([false,false,false]));
 it('step 1 is done once the VieNeu model is installed, and not by another model',()=>{
  expect(done({models:[model('vieneu-v3',true)]})).toEqual([true,false,false]);
  expect(done({models:[model('vieneu-v3',false),model('whisper-small',true)]})).toEqual([false,false,false]);
 });
 it('step 2 is done when a project exists',()=>expect(done({projects:[project]})).toEqual([false,true,false]));
 it('step 3 is done by a succeeded TTS job only',()=>{
  expect(done({jobs:[job('tts','succeeded')]})).toEqual([false,false,true]);
  for(const j of [job('tts','running'),job('tts','failed'),job('tts','queued'),job('render','succeeded'),job('stt','succeeded')])expect(done({jobs:[j]}),j.kind+j.status).toEqual([false,false,false]);
 });
 it('step 3 can only be started when a segment has text, the other steps always can',()=>{
  expect(onboardingSteps({models:[],projects:[],jobs:[],hasText:false}).map(s=>s.ready)).toEqual([true,true,false]);
  expect(onboardingSteps({models:[],projects:[],jobs:[],hasText:true}).map(s=>s.ready)).toEqual([true,true,true]);
 });
 it('is all done for a set-up user',()=>expect(done({models:[model('vieneu-v3',true)],projects:[project],jobs:[job('tts','succeeded')]})).toEqual([true,true,true]));
});
