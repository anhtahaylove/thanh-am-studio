import {describe,expect,it} from 'vitest';
import {switchOffset} from './domain';
// Offsets are measured from the start of speech, so switching take keeps the same place in the speech.
const r=(trim_start_ms:number,trim_end_ms:number|null,duration_ms:number)=>({trim_start_ms,trim_end_ms,duration_ms});
describe('switchOffset',()=>{
 it('keeps the same distance into the speech',()=>expect(switchOffset(800,r(500,3500,4000),r(1000,5000,6000))).toBe(800));
 it('clamps to the target take trim window',()=>expect(switchOffset(2800,r(500,3500,4000),r(0,1500,2000))).toBe(1500));
 it('clamps to the source take trim window',()=>expect(switchOffset(9000,r(500,3500,4000),r(1000,5000,6000))).toBe(3000));
 it('uses the whole take when it has no trim end',()=>expect(switchOffset(1500,r(0,null,2000),r(0,null,6000))).toBe(1500));
 it('never goes below zero or returns NaN',()=>{expect(switchOffset(-5,r(0,null,2000),r(0,null,2000))).toBe(0);expect(switchOffset(NaN,r(0,null,2000),r(0,null,2000))).toBe(0);});
 it('rounds to whole milliseconds',()=>expect(switchOffset(800.6,r(0,null,2000),r(0,null,2000))).toBe(801));
});
