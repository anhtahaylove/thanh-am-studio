import {describe,it,expect} from 'vitest';
import {version} from '../package.json';
import {CHANGELOG,changesSince,compareVersions} from './changelog';

describe('changelog',()=>{
 it('compares versions by number, not by text',()=>{
  expect(compareVersions('1.0.10','1.0.9')).toBe(1);expect(compareVersions('1.0.9','1.0.10')).toBe(-1);
  expect(compareVersions('1.0.11','1.0.11')).toBe(0);expect(compareVersions('1.1','1.0.12')).toBe(1);expect(compareVersions('2.0.0','1.9.99')).toBe(1);
 });
 it('shows the changes between the last seen version and the running one',()=>{
  expect(changesSince('1.0.8','1.0.10').map(e=>e.version)).toEqual(['1.0.10','1.0.9']);
  expect(changesSince('1.0.10','1.0.10')).toEqual([]);
 });
 it('has a Vietnamese entry for the version being built, newest first, each with changes',()=>{
  expect(CHANGELOG[0].version).toBe(version);
  for(const [i,e] of CHANGELOG.entries()){expect(e.changes.length).toBeGreaterThan(0);if(i)expect(compareVersions(CHANGELOG[i-1].version,e.version)).toBe(1);}
 });
});
