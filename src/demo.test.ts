import {describe,it,expect} from 'vitest';
import {chapterGroups,normalizeText,suspiciousRows,validRange} from './domain';
import {DEMO_NAME,demoProject} from './demo';
describe('demo project',()=>{
 const demo=demoProject();
 it('has the name the open flow looks for',()=>expect(DEMO_NAME).toBe('Làng chài · dự án mẫu'));
 it('has 8 segments with 3 speakers, text, no takes and unique ids',()=>{
  expect(demo.segments).toHaveLength(8);
  expect(new Set(demo.segments.map(s=>s.speaker)).size).toBe(3);
  expect(demo.segments.every(s=>s.text.trim()&&!s.takes.length&&s.selected_take_id===null)).toBe(true);
  expect(new Set(demo.segments.map(s=>s.id)).size).toBe(8);
  expect(demoProject().segments[0].id).not.toBe(demo.segments[0].id);
 });
 it('has the HTX entry, one pause mark, and a normalized_text that matches the dictionary',()=>{
  expect(demo.dictionary).toEqual({HTX:'hợp tác xã'});
  expect(demo.segments.filter(s=>/\[nghỉ 0\.5s\]/.test(s.text))).toHaveLength(1);
  for(const s of demo.segments)expect(s.normalized_text,s.text).toBe(normalizeText(s.text,demo.dictionary));
  expect(demo.segments.some(s=>/hợp tác xã/.test(s.normalized_text)&&!/hợp tác xã/.test(s.text))).toBe(true);
 });
 it('starts two chapters, on segments 1 and 5',()=>{
  expect(demo.segments.map(s=>!!s.chapter?.trim())).toEqual([true,false,false,false,true,false,false,false]);
  expect(chapterGroups(demo.segments).map(g=>g.segments.length)).toEqual([4,4]);
 });
 it('has 8 transcript rows for speakers 0 and 1, all with a valid range, one overlap and one repeat',()=>{
  expect(demo.transcript).toHaveLength(8);
  expect(demo.transcript.every(r=>validRange(r.start_ms,r.end_ms)&&r.text.trim())).toBe(true);
  expect(new Set(demo.transcript.map(r=>r.speaker))).toEqual(new Set([0,1]));
  expect(demo.transcript.filter(r=>r.overlap_speaker!==undefined&&r.overlap_speaker!==null)).toHaveLength(1);
  expect(demo.transcript.every((r,i)=>i===0||r.start_ms>=demo.transcript[i-1].end_ms)).toBe(true);
  expect(new Set(demo.transcript.map(r=>r.id)).size).toBe(8);
 });
 it('flags exactly one suspicious row, the repeated line',()=>{
  const flagged=suspiciousRows(demo.transcript);
  expect(flagged.size).toBe(1);
  expect([...flagged.values()]).toEqual([['repeat']]);
 });
});
