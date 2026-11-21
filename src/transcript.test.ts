import {describe,it,expect} from 'vitest';
import {clock,parseTime,timestamp} from './domain';
describe('transcript clock and time parsing',()=>{
 it('writes minutes, seconds and milliseconds, and hours only on request',()=>{
  expect(clock(9200)).toBe('0:09,200');expect(clock(0)).toBe('0:00,000');expect(clock(754321)).toBe('12:34,321');
  expect(clock(3723400,true)).toBe('1:02:03,400');expect(clock(9200,true)).toBe('0:00:09,200');
 });
 it('round-trips what it writes through parseTime',()=>{
  for(const ms of [0,9200,754321,3723400])expect(parseTime(clock(ms,true))).toBe(ms);
  expect(parseTime(clock(754321))).toBe(754321);expect(parseTime(timestamp(1250))).toBe(1250);
 });
 it('accepts a short fraction and a dot, and rejects a bare number and minutes or seconds of 60',()=>{
  expect(parseTime('0:09,2')).toBe(9200);expect(parseTime('00:00:09.200')).toBe(9200);expect(parseTime(' 1:02 ')).toBe(62000);
  for(const bad of ['9','1:60','1:60:00','a:b','','-1:00'])expect(()=>parseTime(bad),bad).toThrow('Mốc thời gian không hợp lệ');
 });
});
