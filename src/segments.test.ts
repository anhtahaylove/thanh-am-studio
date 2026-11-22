import {describe,expect,it} from 'vitest';
import {latestSegmentJobs,segmentJobs} from './domain';
import type {Job} from './types';
// What a segment row shows about its newest tts job.
const job=(id:string,segment:string,status:Job['status'],progress=0,created_at='2026-11-22T00:00:00Z',extra:Partial<Job>={}):Job=>({id,kind:'tts',project_id:'p1',payload:{segment_id:segment},status,progress,error:null,result:null,created_at,updated_at:created_at,...extra});
describe('segmentJobs',()=>{
 it('is empty without jobs',()=>expect(segmentJobs([],'p1').size).toBe(0));
 it('names each state: queued, batch, running with a percentage, failed, cancelled, interrupted',()=>{
  const m=segmentJobs([job('1','a','queued'),job('2','b','running',0),job('3','c','running',0.424),job('4','d','failed'),job('5','e','cancelled'),job('6','f','interrupted')],'p1');
  expect([...m]).toEqual([['a','queued'],['b','batch'],['c','running:42'],['d','failed'],['e','cancelled'],['f','interrupted']]);
 });
 it('a succeeded newest job has no entry, and progress past 100 % is capped',()=>{
  expect(segmentJobs([job('1','a','succeeded',1)],'p1').has('a')).toBe(false);expect(segmentJobs([job('1','a','running',1.7)],'p1').get('a')).toBe('running:100');
 });
 it('the newest job of a segment wins, whatever the order of the list',()=>{
  const old=job('1','a','failed',0,'2026-11-22T00:00:00Z'),fresh=job('2','a','queued',0,'2026-11-22T00:05:00Z');
  expect(segmentJobs([fresh,old],'p1').get('a')).toBe('queued');expect(segmentJobs([old,fresh],'p1').get('a')).toBe('queued');
  expect(segmentJobs([job('3','a','succeeded',1,'2026-11-22T00:09:00Z'),fresh,old],'p1').has('a')).toBe(false);
 });
 it('on a tie the first of the list (the newest first) wins',()=>expect(segmentJobs([job('1','a','queued'),job('2','a','failed')],'p1').get('a')).toBe('queued'));
 it('ignores other projects, other kinds and jobs with no segment',()=>{
  const m=segmentJobs([job('1','a','queued',0,undefined,{project_id:'p2'}),job('2','b','queued',0,undefined,{kind:'stt'}),job('3','c','queued',0,undefined,{payload:{}}),job('4','d','queued',0,undefined,{payload:{segment_id:7}})],'p1');
  expect(m.size).toBe(0);
 });
 it('latestSegmentJobs gives the job itself',()=>expect(latestSegmentJobs([job('1','a','queued')],'p1').get('a')?.id).toBe('1'));
});
