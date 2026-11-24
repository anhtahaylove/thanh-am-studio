import {describe,it,expect} from 'vitest';
import {takeIndex,voiceSample} from './voiceSample';
import type {Job,Project,Voice} from './types';

const voices:Voice[]=[{id:'v-ref',name:'Giọng thu',kind:'reference',reference_asset_id:'a-ref',consent:true,engine_voice_id:null},{id:'v-preset',name:'Bắc nữ',kind:'preset',reference_asset_id:null,consent:false,engine_voice_id:'north-f'}];
const take=(id:string,asset:string,speech?:number)=>({id,asset_id:asset,path:`C:\\takes\\${asset}.wav`,duration_ms:6000,sample_rate:24000,created_at:'2026-11-20T00:00:00Z',...speech===undefined?{}:{speech_start_ms:speech}});
const seg=(id:string,takes:ReturnType<typeof take>[])=>({id,text:'Xin chào.',normalized_text:'Xin chào.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes,selected_take_id:takes[0]?.id??null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
const project:Project={id:'p1',name:'Dự án một',updated_at:'',revision:1,segments:[seg('s1',[]),seg('s2',[take('t1','a1'),take('t2','a2',480)])],transcript:[],dictionary:{},source_asset_id:null};
const projects=[{id:'p1',name:'Dự án một',updated_at:'',revision:1},{id:'p2',name:'Làng chài',updated_at:'',revision:1}];
const job=(o:{kind?:string;project?:string|null;payload?:Record<string,unknown>;result?:Record<string,unknown>|null;status?:Job['status'];at?:string}):Job=>({id:Math.random().toString(36),kind:o.kind??'tts',project_id:o.project===undefined?'p1':o.project,payload:o.payload??{},status:o.status??'succeeded',progress:1,error:null,result:o.result===undefined?null:o.result,created_at:o.at??'2026-11-21T12:00:00Z',updated_at:''});
const tts=(voice:string|null,asset:string,o:{project?:string;speech?:number;at?:string}={})=>job({project:o.project,payload:{segment_id:'s2',text:'x',voice_id:voice,reference_asset_id:null},result:{asset_id:asset,path:`C:\\takes\\${asset}.wav`,...o.speech===undefined?{}:{speech_start_ms:o.speech}},at:o.at});
const sample=(voiceId:string|null,jobs:Job[])=>voiceSample(voiceId,{voices,jobs,project,projects,version:'1.0.23'});

describe('voiceSample',()=>{
 it('plays a reference voice from its cleaned sample of this version, else from the recording itself',()=>{
  const clean=(version:string)=>job({kind:'clone_preview',project:null,payload:{asset_id:'a-ref',version},result:{asset_id:'c1',path:'C:\\assets\\c1.wav'}});
  expect(sample('v-ref',[clean('1.0.23')])).toEqual({kind:'clean',path:'C:\\assets\\c1.wav',start_ms:0,title:'Phát 3 giây mẫu đã làm sạch'});
  expect(sample('v-ref',[clean('1.0.22')])).toEqual({kind:'reference',assets:[{assetId:'a-ref',start_ms:0}],title:'Phát 3 giây đầu mẫu giọng đã ghi'});
  expect(sample('v-ref',[])).toEqual({kind:'reference',assets:[{assetId:'a-ref',start_ms:0}],title:'Phát 3 giây đầu mẫu giọng đã ghi'});
  expect(sample('v-ref',[{...clean('1.0.23'),status:'running',result:null}]).kind).toBe('reference');
 });
 it('plays a preset from the newest take made with it that is still in this project, from its speech start',()=>{
  expect(sample('v-preset',[tts('v-preset','a2'),tts('v-preset','a1')])).toEqual({kind:'take',path:'C:\\takes\\a2.wav',start_ms:480,title:'Phát 3 giây từ take 2 của đoạn 2'});
  expect(sample('v-preset',[tts('v-preset','a1')])).toEqual({kind:'take',path:'C:\\takes\\a1.wav',start_ms:0,title:'Phát 3 giây từ take 1 của đoạn 2'});
  // The App builds the take lookup once for every speaker of a render and passes it in.
  expect(voiceSample('v-preset',{voices,jobs:[tts('v-preset','a2')],project,projects,version:'1.0.23',takes:takeIndex(project)})).toEqual(sample('v-preset',[tts('v-preset','a2')]));
  expect(voiceSample('v-preset',{voices,jobs:[tts('v-preset','a2')],project,projects,version:'1.0.23',takes:new Map()}).kind).toBe('blocked'); // the lookup passed in is the one used
 });
 it('falls back for a preset to takes of other projects, naming the newest one\'s project and date, with at most 3 to try',()=>{
  const jobs=[tts('v-preset','b3',{project:'p2',speech:200,at:'2026-11-21T12:00:00Z'}),tts('v-preset','b2',{project:'p2'}),tts('v-preset','gone',{project:'p-deleted'}),tts('v-preset','b1',{project:'p2'}),tts('v-preset','b0',{project:'p2'})];
  expect(sample('v-preset',jobs)).toEqual({kind:'job',assets:[{assetId:'b3',start_ms:200},{assetId:'b2',start_ms:0},{assetId:'b1',start_ms:0}],title:'Phát 3 giây từ một take của dự án Làng chài (21/11/2026)'});
 });
 it('blocks a preset whose only take was deleted from this project',()=>{
  expect(sample('v-preset',[tts('v-preset','a-deleted')])).toEqual({kind:'blocked',blocked:'Chưa có take nào tạo bằng giọng này: tạo giọng một đoạn trước.'});
 });
 it('never takes the engine default voice from another project, and plays it from a take here',()=>{
  expect(sample(null,[tts(null,'b1',{project:'p2'})])).toEqual({kind:'blocked',blocked:'Chưa có take nào trong dự án này tạo bằng giọng mặc định: tạo giọng một đoạn trước.'});
  expect(sample(null,[tts(null,'b1',{project:'p2'}),tts(null,'a1')])).toEqual({kind:'take',path:'C:\\takes\\a1.wav',start_ms:0,title:'Phát 3 giây từ take 1 của đoạn 2'});
  expect(sample(null,[job({payload:{segment_id:'s2',text:'x'},result:{asset_id:'a1'}})]).kind).toBe('take'); // an older payload without voice_id is the default voice
 });
 it('ignores jobs of another kind, unfinished jobs and takes of another voice',()=>{
  const jobs=[job({kind:'render',payload:{voice_id:'v-preset'},result:{asset_id:'a1'}}),job({kind:'clone_preview',payload:{voice_id:'v-preset'},result:{asset_id:'a2',path:'x'}}),{...tts('v-preset','a1'),status:'failed' as const},tts('v-other','a2'),tts('v-preset','b1',{project:'p2'}),{...tts('v-preset','b2',{project:'p2'}),status:'running' as const,result:null}];
  expect(sample('v-preset',jobs)).toEqual({kind:'job',assets:[{assetId:'b1',start_ms:0}],title:'Phát 3 giây từ một take của dự án Làng chài (21/11/2026)'});
  expect(sample('v-preset',jobs.slice(0,4)).kind).toBe('blocked');
 });
});
