import log from './changelog.vi.json';

/** One release in the bundled Vietnamese changelog (newest first); release.yml also copies an entry into the update feed. */
export interface ChangelogEntry {version:string;date:string;changes:string[]}
export const CHANGELOG:ChangelogEntry[]=log;

/** Compares dotted version numbers: negative, zero or positive (1.0.10 is newer than 1.0.9). */
export function compareVersions(a:string,b:string):number{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return Math.sign(d);}return 0;}

/** Entries newer than the last version the user saw, up to the running one: what "Có gì mới" shows after an update. */
export const changesSince=(seen:string,current:string,entries=CHANGELOG)=>entries.filter(e=>compareVersions(e.version,seen)>0&&compareVersions(e.version,current)<=0);
