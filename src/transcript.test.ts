import {describe,it,expect} from 'vitest';
import {clock,countExact,parseTime,replaceInTranscript,searchParts,timestamp,wordStartMs} from './domain';
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
describe('countExact',()=>{
 const rows=[{id:'a',start_ms:0,end_ms:1,text:'Mua cá thu, cá thu tươi'},{id:'b',start_ms:1,end_ms:2,text:'ca thu rẻ'},{id:'c',start_ms:2,end_ms:3,text:'CÁ THU và Cá Thu'},{id:'d',start_ms:3,end_ms:4,text:'a.b (c) a.b'}];
 it('counts only the places replaceInTranscript would change: tone marks count, case does not',()=>{
  expect(countExact(rows,'cá thu')).toBe(4);expect(countExact(rows,'ca thu')).toBe(1);expect(countExact(rows,'xyz')).toBe(0);expect(countExact(rows,'')).toBe(0);
  for(const q of ['cá thu','ca thu','xyz','a.b','(c)'])expect(countExact(rows,q),q).toBe(replaceInTranscript(rows,q,'#').count);
 });
 it('treats the query as text, not a pattern, and builds no new rows',()=>{
  expect(countExact(rows,'a.b')).toBe(2);expect(countExact(rows,'(c)')).toBe(1);expect(countExact(rows,'.')).toBe(2);
  const before=JSON.stringify(rows);countExact(rows,'cá thu');expect(JSON.stringify(rows)).toBe(before);
 });
 it('matches across normalization forms like the replace does',()=>{
  const nfd=[{id:'n',start_ms:0,end_ms:1,text:'cá thu'}];expect(countExact(nfd,'cá thu')).toBe(1);expect(replaceInTranscript(nfd,'cá thu','x').count).toBe(1);
 });
});
describe('a query that overlaps itself after folding',()=>{
 // Known limit, pinned: the preview folds tone marks, so "dạ dạ" in "da dạ dạ" is one hit over "da dạ" (shown dashed, not exact), while Replace
 // and its count still find the exact pair at the end. Upgrade to an exact-first split if users run into it.
 const rows=[{id:'a',start_ms:0,end_ms:1,text:'da dạ dạ'}];
 it('shows one hit that is not the exact text, and Replace still changes the exact match',()=>{
  expect(searchParts('da dạ dạ','dạ dạ')).toEqual([{text:'da dạ',hit:true},{text:' dạ',hit:false}]);
  expect(countExact(rows,'dạ dạ')).toBe(1);
  const r=replaceInTranscript(rows,'dạ dạ','X');expect(r.count).toBe(1);expect(r.rows[0].text).toBe('da X');
 });
});
describe('wordStartMs',()=>{
 const row={start_ms:10000,end_ms:14000,text:'aaa bbb ccc ddd'}; // 15 characters over 4,000 ms
 it('snaps to the start of the word and interpolates by character',()=>{
  expect(wordStartMs(row,8)).toBe(12133);
  for(const inside of [8,9,10,11])expect(wordStartMs(row,inside),`offset ${inside}`).toBe(12133);
  expect(wordStartMs(row,12)).toBe(13200);expect(wordStartMs(row,0)).toBe(10000);expect(wordStartMs(row,4)).toBe(11067);
 });
 it('treats the end of the text as the last word and clamps odd offsets',()=>{
  expect(wordStartMs(row,15)).toBe(13200);expect(wordStartMs(row,999)).toBe(13200);expect(wordStartMs(row,-5)).toBe(10000);expect(wordStartMs(row,Number.NaN)).toBe(10000);
 });
 it('puts a caret in trailing whitespace on the last word, so the result is before the end of the row',()=>{
  const at=(text:string,offset:number)=>wordStartMs({start_ms:10000,end_ms:14000,text},offset);
  expect(at('aaa bbb ',8)).toBe(12286);expect(at('abc def\n',8)).toBe(12286);expect(at('   ',3)).toBe(10000);expect(at('aaa bbb ccc ddd ',16)).toBe(13200);
  for(const [text,offset] of [['aaa bbb ',8],['abc def\n',8],['   ',3],['x ',2],['',0]] as const)expect(at(text,offset),text).toBeLessThan(14000);
 });
 it('stays inside the row for an empty text and for a row that ends before it starts',()=>{
  expect(wordStartMs({start_ms:500,end_ms:900,text:''},3)).toBe(500);expect(wordStartMs({start_ms:900,end_ms:500,text:'ab cd'},4)).toBe(900);
 });
});
