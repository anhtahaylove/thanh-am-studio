import {describe,it,expect} from 'vitest';
import {progressLabel,jobProgressLabel,parseSubtitles,exportSubtitles,normalizeText,splitText,splitTranscript,mergeTranscript,clipDuration,validateRecipe,ttsTranscript,makeSegment,splitSegment,mergeSegments,restoreSnapshot,addTranscriptRow,validRange,replaceInTranscript,rowAt,spokenText} from './domain';
import type {Project,Take} from './types';
describe('subtitle and text contracts',()=>{
 it('reads BOM SRT and multiline Vietnamese',()=>{expect(parseSubtitles('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nXin chào\r\nViệt Nam\r\n')).toMatchObject([{start_ms:1250,end_ms:3500,text:'Xin chào\nViệt Nam'}]);});
 it('reads VTT settings without treating header as dialogue',()=>{expect(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nChào bạn')).toMatchObject([{start_ms:1000,end_ms:2000,text:'Chào bạn'}]);});
 it('rejects reversed subtitle ranges',()=>{expect(()=>parseSubtitles('1\n00:00:02,000 --> 00:00:01,000\nSai')).toThrow('thời gian');});
 it('roundtrips SRT and VTT with millisecond precision',()=>{const rows=[{id:'a',start_ms:1234,end_ms:5678,text:'Tiếng Việt'}]; for(const ext of ['srt','vtt'] as const)expect(parseSubtitles(exportSubtitles(rows,ext))).toMatchObject([{start_ms:1234,end_ms:5678,text:'Tiếng Việt'}]);});
 it('normalizes dictionary literally and prefers longer keys',()=>{expect(normalizeText('TP.HCM dùng AI.',{'TP.HCM':'Thành phố Hồ Chí Minh','AI':'ây ai'})).toBe('Thành phố Hồ Chí Minh dùng ây ai.');});
 it('normalizes dates and currency without deleting original punctuation',()=>{expect(normalizeText('Ngày 10/11/2026, giá 20.000đ.',{})).toContain('tháng');});
 it('splits long prose without losing words',()=>{const x=Array.from({length:1000},()=> 'xin').join(' '); const parts=splitText(x);expect(parts.length).toBeGreaterThan(1);expect(parts.join(' ')).toBe(x);expect(parts.every(p=>p.length<=500)).toBe(true);});
 it('splits and merges transcript preserving endpoints',()=>{const x={id:'a',start_ms:1000,end_ms:5000,text:'Xin chào bạn thân'};const parts=splitTranscript(x);expect(parts[0].start_ms).toBe(1000);expect(parts[1].end_ms).toBe(5000);expect(mergeTranscript(parts[0],parts[1]).text).toBe(x.text);});
});
describe('preview/export recipe invariants',()=>{
 const clip={duration_ms:5000,trim_start_ms:1000,trim_end_ms:4000,gap_ms:250,fade_in_ms:100,fade_out_ms:200,gain_db:0};
 it('uses same trimmed duration with gap',()=>expect(clipDuration(clip)).toBe(3250));
 it('rejects out-of-range trim',()=>expect(()=>validateRecipe({...clip,trim_end_ms:6000})).toThrow('Trim'));
 it('rejects overlapping fades',()=>expect(()=>validateRecipe({...clip,fade_in_ms:2000,fade_out_ms:2000})).toThrow('Fade'));
 it('exports TTS subtitles based on rendered clip positions',()=>expect(ttsTranscript([{...clip,text:'Một'},{...clip,text:'Hai'}])).toMatchObject([{start_ms:0,end_ms:3000,text:'Một'},{start_ms:3250,end_ms:6250,text:'Hai'}]));
});
describe('sentence-aware text import',()=>{
 it('packs whole sentences up to the limit and never cuts a word',()=>{const sentence='Đây là một câu khá dài để kiểm tra việc gom câu.';const text=Array.from({length:30},()=>sentence).join(' ');const parts=splitText(text,200);expect(parts.length).toBeGreaterThan(1);expect(parts.every(p=>p.length<=200&&p.endsWith('.'))).toBe(true);expect(parts.join(' ')).toBe(text);});
 it('keeps abbreviations with dots inside words and treats newlines as boundaries',()=>{expect(splitText('Xin chào TP.HCM! Hôm nay 3.5 kg?\nDòng hai…  Dòng ba.')).toEqual(['Xin chào TP.HCM! Hôm nay 3.5 kg?','Dòng hai… Dòng ba.']);});
 it('falls back to word cuts only for a single oversized sentence',()=>{const long=Array.from({length:100},()=>'xin').join(' ');const parts=splitText(`Ngắn. ${long}. Cuối.`,50);expect(parts[0]).toBe('Ngắn.');expect(parts.every(p=>p.length<=50)).toBe(true);expect(parts.join(' ')).toBe(`Ngắn. ${long}. Cuối.`);});
});
const take=(id:string):Take=>({id,asset_id:'a'+id,path:id+'.wav',duration_ms:1000,sample_rate:48000,created_at:'t'});
describe('segment split and merge',()=>{
 const seg={...makeSegment('Xin chào bạn. Tôi là Lan. Rất vui.'),takes:[take('t1')],selected_take_id:'t1',trim_end_ms:500};
 it('splits at the cursor: first keeps id and takes, second is fresh',()=>{const [a,b]=splitSegment(seg,'Xin chào bạn. Tôi là'.length);expect(a).toMatchObject({id:seg.id,text:'Xin chào bạn. Tôi là',takes:[take('t1')],selected_take_id:'t1'});expect(b.text).toBe('Lan. Rất vui.');expect(b.id).not.toBe(seg.id);expect(b).toMatchObject({takes:[],selected_take_id:null,trim_end_ms:null,speaker:seg.speaker});});
 it('splits at the sentence boundary closest to the middle without a usable cursor',()=>{for(const c of [undefined,0,seg.text.length]){const [a,b]=splitSegment(seg,c);expect(a.text).toBe('Xin chào bạn.');expect(b.text).toBe('Tôi là Lan. Rất vui.');}});
 it('falls back to a word boundary and refuses one-word text',()=>{const [a,b]=splitSegment(makeSegment('một hai ba bốn'));expect([a.text,b.text]).toEqual(['một hai','ba bốn']);expect(()=>splitSegment(makeSegment('một'))).toThrow('Đoạn');});
 it('normalizes both halves with the dictionary',()=>{const [a,b]=splitSegment(makeSegment('Xin chào. TP.HCM đẹp.'),undefined,{'TP.HCM':'Thành phố'});expect(b.normalized_text).toBe('Thành phố đẹp.');expect(a.normalized_text).toBe('Xin chào.');});
 it('merges keeping the first id, takes and the second gap',()=>{const second={...makeSegment('Hai.'),takes:[take('t2')],gap_ms:700};const m=mergeSegments(seg,second);expect(m).toMatchObject({id:seg.id,text:seg.text+' Hai.',takes:[take('t1')],selected_take_id:'t1',gap_ms:700});});
});
describe('undo restore',()=>{
 const proj=(segments:Project['segments'],revision=0):Project=>({id:'p',name:'n',updated_at:`r${revision}`,revision,segments,transcript:[],dictionary:{},source_asset_id:null});
 it('keeps takes that landed after the snapshot and the current revision',()=>{const s0=makeSegment('a');const snap=proj([s0],1);const cur=proj([{...s0,text:'b',takes:[take('t1')],selected_take_id:'t1'}],3);const r=restoreSnapshot(snap,cur);expect(r).toMatchObject({revision:3,updated_at:'r3'});expect(r.segments[0]).toMatchObject({text:'a',takes:[take('t1')],selected_take_id:'t1'});});
 it('restores detached takes from the snapshot and keeps new segments that own takes',()=>{const a={...makeSegment('a'),takes:[take('t1')]},b=makeSegment('b');const fresh={...makeSegment('c'),takes:[take('t9')]},empty=makeSegment('d');const r=restoreSnapshot(proj([a,b]),proj([b,fresh,empty]));expect(r.segments.map(s=>s.id)).toEqual([a.id,fresh.id,b.id]);expect(r.segments[0].takes).toEqual([take('t1')]);});
});
describe('transcript rows',()=>{
 const rows=[{id:'a',start_ms:0,end_ms:2000,text:'x'},{id:'b',start_ms:2000,end_ms:3000,text:'y'}];
 it('inserts a one second row after the active row, or at the end',()=>{const r=addTranscriptRow(rows,'a');expect(r.map(x=>x.id)[0]).toBe('a');expect(r[1]).toMatchObject({start_ms:2000,end_ms:3000,text:''});expect(r).toHaveLength(3);const e=addTranscriptRow(rows,null);expect(e[2]).toMatchObject({start_ms:3000,end_ms:4000});expect(addTranscriptRow([],null)[0]).toMatchObject({start_ms:0,end_ms:1000});});
 it('labels job progress with a remaining-time estimate once it is meaningful',()=>{const start='2026-11-11T06:00:00Z',t=Date.parse(start);expect(progressLabel(0.05,start,t+60000)).toBe('5 %');expect(progressLabel(0.5,start,t+20*60000)).toBe('50 % · còn ~20 phút');expect(progressLabel(0.999,start,t+60000)).toBe('99 % · còn ~1 phút');expect(progressLabel(0.5,'bad',t)).toBe('50 %');});
 it('marks batched TTS jobs that have not started as waiting',()=>{const start='2026-11-11T06:00:00Z',t=Date.parse(start);expect(jobProgressLabel('tts',0,start,t)).toBe('Chờ trong lô');expect(jobProgressLabel('tts',0.5,start,t+60000)).toBe('50 % · còn ~1 phút');expect(jobProgressLabel('stt',0,start,t)).toBe('0 %');});
 it('replaces text case-insensitively across rows and counts each match',()=>{const rows=[{id:'a',start_ms:0,end_ms:1000,text:'Chợ biến thành, biến thành'},{id:'b',start_ms:1000,end_ms:2000,text:'không đổi'}];const r=replaceInTranscript(rows,'BIẾN thành','Bến Thành');expect(r.count).toBe(2);expect(r.rows[0].text).toBe('Chợ Bến Thành, Bến Thành');expect(r.rows[1]).toBe(rows[1]);expect(replaceInTranscript(rows,'',"x")).toEqual({rows,count:0});expect(replaceInTranscript(rows,'a.b','x').count).toBe(0);});
 it('finds the row being heard at a playback position',()=>{const rows=[{id:'a',start_ms:0,end_ms:1000,text:''},{id:'b',start_ms:1500,end_ms:2000,text:''}];expect(rowAt(rows,999)).toBe('a');expect(rowAt(rows,1000)).toBeNull();expect(rowAt(rows,1500)).toBe('b');expect(rowAt(rows,2000)).toBeNull();});
 it('keeps pause marks out of dictionary rules and out of subtitles',()=>{expect(normalizeText('Nghỉ ngơi [nghỉ 0,5s] rồi đi',{'nghỉ':'NGHỈ','Nghỉ':'Ngơi'})).toBe('Ngơi ngơi [nghỉ 0,5s] rồi đi');expect(spokenText('A [nghỉ 1s]  B [NGHỈ 200ms]')).toBe('A B');expect(spokenText('giữ [ghi chú]')).toBe('giữ [ghi chú]');});
 it('validates ranges the way the backend does',()=>{expect(validRange(0,1)).toBe(true);for(const [a,b] of [[5,5],[6,5],[-1,5],[0,NaN]])expect(validRange(a,b)).toBe(false);});
});
