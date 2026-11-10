import {describe,it,expect} from 'vitest';
import {parseSubtitles,exportSubtitles,normalizeText,splitText,splitTranscript,mergeTranscript,clipDuration,validateRecipe,ttsTranscript} from './domain';
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
