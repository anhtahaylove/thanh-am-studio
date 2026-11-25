import {describe,it,expect} from 'vitest';
import {jobNotices,noticeText} from './notify';
import type {Job} from './types';

const T0=Date.parse('2026-11-25T10:00:00Z');
const job=(id:string,kind:string,status:Job['status'],at=T0):Job=>({id,kind,project_id:null,payload:{},status,progress:0,error:null,result:null,created_at:new Date(at).toISOString(),updated_at:new Date(at).toISOString()});
const ids=(list:Job[])=>list.map(j=>j.id);

describe('jobNotices',()=>{
 it('names a job that ended after running for 30 s, and not one that ended after 29.9 s',()=>{
  const seen=new Map<string,number>();
  expect(jobNotices(seen,[job('a','stt','running'),job('b','stt','running')],T0)).toEqual([]);
  expect(ids(jobNotices(seen,[job('a','stt','succeeded')],T0+30000))).toEqual(['a']);
  expect(jobNotices(seen,[job('b','stt','succeeded')],T0+29900)).toEqual([]);
 });
 it('counts a job seen running from its updated_at, not from the first poll',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','running',T0-40000)],T0);
  expect(ids(jobNotices(seen,[job('a','stt','succeeded')],T0+1000))).toEqual(['a']);
 });
 it('counts a job seen queued from that poll, even if it ends before the next poll shows it running',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','render','queued')],T0);
  expect(ids(jobNotices(seen,[job('a','render','succeeded')],T0+31000))).toEqual(['a']);
 });
 it('counts a job seen queued from the poll time, not from its updated_at',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','queued',T0-40000)],T0);
  expect(jobNotices(seen,[job('a','stt','succeeded')],T0+1000)).toEqual([]);
 });
 it('counts a running job with an unparsable updated_at from the poll time',()=>{
  const seen=new Map<string,number>(),bad=(id:string,status:Job['status'])=>({...job(id,'stt',status),updated_at:'x'});
  jobNotices(seen,[bad('a','running'),bad('b','running')],T0);
  expect(ids(jobNotices(seen,[bad('a','succeeded')],T0+30000))).toEqual(['a']);
  expect(jobNotices(seen,[bad('b','succeeded')],T0+29900)).toEqual([]);
 });
 it('keeps the queued start when the job is then seen running',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','separate','queued')],T0);
  jobNotices(seen,[job('a','separate','running',T0+20000)],T0+20000);
  expect(ids(jobNotices(seen,[job('a','separate','succeeded')],T0+30000))).toEqual(['a']);
 });
 it('names a failed job too',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','separate','running')],T0);
  expect(ids(jobNotices(seen,[job('a','separate','failed')],T0+60000))).toEqual(['a']);
 });
 it('names only stt, render and separate jobs',()=>{
  const seen=new Map<string,number>(),kinds=['stt','render','separate','tts','clone_preview','other'];
  jobNotices(seen,kinds.map(k=>job(k,k,'running')),T0);
  expect(ids(jobNotices(seen,kinds.map(k=>job(k,k,'succeeded')),T0+60000))).toEqual(['stt','render','separate']);
 });
 it('names nothing for a cancelled or interrupted job, and forgets it',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','running'),job('b','stt','running')],T0);
  expect(jobNotices(seen,[job('a','stt','cancelled'),job('b','stt','interrupted')],T0+60000)).toEqual([]);
  expect(jobNotices(seen,[job('a','stt','succeeded'),job('b','stt','succeeded')],T0+90000)).toEqual([]);
 });
 it('names nothing for a job that is already over at the first poll',()=>{
  expect(jobNotices(new Map(),[job('a','stt','succeeded'),job('b','render','failed')],T0+60000)).toEqual([]);
 });
 it('names a job once: the same list on the next poll names nothing',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','running')],T0);
  expect(jobNotices(seen,[job('a','stt','succeeded')],T0+60000)).toHaveLength(1);
  expect(jobNotices(seen,[job('a','stt','succeeded')],T0+62500)).toEqual([]);
 });
 it('returns every job that ended in one poll together',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','running'),job('b','render','queued'),job('c','stt','running')],T0);
  expect(ids(jobNotices(seen,[job('a','stt','succeeded'),job('b','render','failed'),job('c','stt','running')],T0+60000))).toEqual(['a','b']);
 });
});

describe('jobNotices elapsed time',()=>{
 it('returns how long each ended job ran, from its start to the poll',()=>{
  const seen=new Map<string,number>();
  jobNotices(seen,[job('a','stt','running',T0-40000)],T0);
  expect(jobNotices(seen,[job('a','stt','succeeded')],T0+20000).map(j=>j.ms)).toEqual([60000]);
 });
});

const done=(kind:string,status:string,name:string,min:number)=>({kind,status,name,ms:min*60000});

describe('noticeText',()=>{
 it('titles a finished job by its kind and gives its name and duration',()=>{
  expect(noticeText([done('stt','succeeded','phong-van.mp3',7)])).toEqual({title:'Đã chép lời xong',body:'phong-van.mp3 · 7 phút'});
  expect(noticeText([done('render','succeeded','Chương 1',2)])).toEqual({title:'Đã xuất audio xong',body:'Chương 1 · 2 phút'});
  expect(noticeText([done('separate','succeeded','nhac.mp3',3)])).toEqual({title:'Đã tách nhạc nền xong',body:'nhac.mp3 · 3 phút'});
 });
 it('titles a failed job by its kind and points to the error',()=>{
  const tail=' · Mở Thanh Âm Studio để xem lỗi.';
  expect(noticeText([done('stt','failed','a.mp3',2)])).toEqual({title:'Chép lời không thành công',body:`a.mp3 · 2 phút${tail}`});
  expect(noticeText([done('render','failed','b',2)]).title).toBe('Xuất audio không thành công');
  expect(noticeText([done('separate','failed','c.wav',2)])).toEqual({title:'Tách nhạc nền không thành công',body:`c.wav · 2 phút${tail}`});
 });
 it('writes the duration in seconds, minutes, or hours and minutes',()=>{
  const body=(ms:number)=>noticeText([{kind:'stt',status:'succeeded',name:'a',ms}]).body;
  expect(body(45000)).toBe('a · 45 giây');
  expect(body(30000)).toBe('a · 30 giây');
  expect(body(90*60000)).toBe('a · 1 giờ 30 phút');
  expect(body(120*60000)).toBe('a · 2 giờ');
 })
 it('rounds seconds and minutes to the nearest, and switches to minutes at 59.5 s',()=>{
  const body=(ms:number)=>noticeText([{kind:'stt',status:'succeeded',name:'a',ms}]).body;
  expect(body(59500)).toBe('a · 1 phút');
  expect(body(60000)).toBe('a · 1 phút');
  expect(body(89000)).toBe('a · 1 phút');
  expect(body(90000)).toBe('a · 2 phút');
 });
 it('leaves the name out when none is known',()=>{
  expect(noticeText([done('stt','succeeded','',2)]).body).toBe('2 phút');
  expect(noticeText([done('stt','failed','',2)]).body).toBe('2 phút · Mở Thanh Âm Studio để xem lỗi.');
 });
 it('counts several jobs in the title and lists up to three in the body',()=>{
  expect(noticeText([done('stt','succeeded','a.mp3',1),done('render','failed','Chương 1',1)])).toEqual({title:'Đã xong 2 công việc',body:'Chép lời: a.mp3; Xuất audio: Chương 1'});
  expect(noticeText([done('stt','succeeded','a',1),done('stt','succeeded','b',1),done('separate','succeeded','',1)]).body).toBe('Chép lời: a; Chép lời: b; Tách nhạc nền');
 });
 it('adds how many more jobs there are past the third',()=>{
  const four=['a','b','c','d'].map(n=>done('stt','succeeded',n,1));
  expect(noticeText(four)).toEqual({title:'Đã xong 4 công việc',body:'Chép lời: a; Chép lời: b; Chép lời: c và 1 việc khác'});
  expect(noticeText([...four,done('render','succeeded','e',1)]).body).toBe('Chép lời: a; Chép lời: b; Chép lời: c và 2 việc khác');
 });
});
