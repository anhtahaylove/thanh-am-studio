import {describe,it,expect} from 'vitest';
import {jobNotices} from './notify';
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
