import type {Project,Segment,Take,TakeCheck,TranscriptSegment} from './types';
export const uid=()=>crypto.randomUUID();
/** A take length for display, in Vietnamese style: one decimal with a comma ("4,1 giây"). */
export const seconds=(ms:number)=>`${(ms/1000).toLocaleString('vi-VN',{minimumFractionDigits:1,maximumFractionDigits:1})} giây`;
export function timestamp(ms:number,separator=','):string {ms=Math.round(ms);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;}
/** Compact clock for the transcript time editor: `0:09,200`, or `1:02:03,400` when `hours` is on. */
export function clock(ms:number,hours=false):string {ms=Math.round(ms);const m=Math.floor(ms/60000),sf=`${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;return hours?`${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:${sf}`:`${m}:${sf}`;}
export function parseTime(value:string):number {const parts=value.trim().replace(',','.').split(':').map(Number);if(parts.length<2||parts.length>3||parts.some(x=>!Number.isFinite(x)||x<0)||parts.at(-1)!>=60||parts.at(-2)!>=60)throw Error('Mốc thời gian không hợp lệ');return Math.round(parts.reduce((a,n)=>a*60+n,0)*1000);}
export function parseSubtitles(input:string):TranscriptSegment[]{
 const blocks=input.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/);const rows:TranscriptSegment[]=[];
 for(const block of blocks){const lines=block.split('\n');if(/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0]))continue;const idx=lines.findIndex(l=>l.includes('-->'));if(idx<0)continue;const match=lines[idx].match(/^(\S+)\s+-->\s+(\S+)/);if(!match)throw Error('Mốc thời gian không hợp lệ');const start_ms=parseTime(match[1]),end_ms=parseTime(match[2]);if(end_ms<=start_ms)throw Error('Khoảng thời gian phải tăng');rows.push({id:uid(),start_ms,end_ms,text:lines.slice(idx+1).join('\n')});}
 if(!rows.length)throw Error('Không tìm thấy đoạn phụ đề hợp lệ');return rows;
}
export function exportSubtitles(rows:TranscriptSegment[],format:'srt'|'vtt'|'txt'):string {
 // Consecutive rows of one speaker become one paragraph "Người N: lời", the form the script import reads back; a row without a speaker stays as it is.
 // The import needs at least two labelled lines, so with a single turn the rows export as they always did.
 if(format==='txt'){const out:{speaker?:number;text:string}[]=[];for(const r of rows){if(r.speaker===undefined){out.push({text:r.text});continue;}const text=r.text.trim().replace(/\s+/g,' '),last=out.at(-1);if(!text)continue;if(last?.speaker===r.speaker)last.text+=' '+text;else out.push({speaker:r.speaker,text});}return out.filter(p=>p.speaker!==undefined).length<2?rows.map(r=>r.text).join('\n\n'):out.map(p=>p.speaker===undefined?p.text:`Người ${p.speaker+1}: ${p.text}`).join('\n\n');}
 for(const r of rows)if(!Number.isFinite(r.start_ms)||!Number.isFinite(r.end_ms)||r.start_ms<0||r.end_ms<=r.start_ms)throw Error('Khoảng thời gian phải tăng');
 return (format==='vtt'?'WEBVTT\n\n':'')+rows.map((r,i)=>`${format==='srt'?`${i+1}\n`:''}${timestamp(r.start_ms,format==='vtt'?'.':',')} --> ${timestamp(r.end_ms,format==='vtt'?'.':',')}\n${r.text}`).join('\n\n')+'\n';
}
const escapeRegExp=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Replaces every case-insensitive literal match of `find` in transcript text; untouched rows keep their identity. */
export function replaceInTranscript(rows:TranscriptSegment[],find:string,replacement:string):{rows:TranscriptSegment[];count:number}{
 if(!find)return {rows,count:0};
 const pattern=new RegExp(escapeRegExp(find.normalize('NFC')),'giu');let count=0;
 const next=rows.map(r=>{const text=r.text.normalize('NFC').replace(pattern,()=>{count++;return replacement;});return text===r.text.normalize('NFC')?r:{...r,text};});
 return {rows:next,count};
}
const foldVi=(s:string)=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase();
/** Splits `text` at every match of `query`, ignoring case, tone marks and the stroke of đ; the parts always concatenate back to `text`. */
export function searchParts(text:string,query:string):{text:string;hit:boolean}[]{
 const q=foldVi(query);if(!query)return [{text,hit:false}];
 // Fast path: most rows do not match, and folding the whole text at once is far cheaper than the per-character loop below.
 if(!foldVi(text).includes(q))return [{text,hit:false}];
 // Fold char by char so every folded index maps back to an offset in the original, whatever its normalization form.
 let folded='';const at:number[]=[];let i=0;
 for(const ch of text){const f=foldVi(ch);for(let k=0;k<f.length;k++)at.push(i);folded+=f;i+=ch.length;}
 const parts:{text:string;hit:boolean}[]=[];let last=0;
 for(let p=q?folded.indexOf(q):-1;p>=0;p=folded.indexOf(q,p+q.length)){
  const from=at[p],to=at[p+q.length]??text.length;
  if(from>last)parts.push({text:text.slice(last,from),hit:false});
  parts.push({text:text.slice(from,to),hit:true});last=to;
 }
 if(last<text.length||!parts.length)parts.push({text:text.slice(last),hit:false});
 return parts;
}
/** Badge for a take that Whisper listened back to; soft mismatches (merged initials/finals) do not warn. */
export function checkSummary(check:TakeCheck|undefined):{tone:'ok'|'warn';label:string;detail:string}|null{
 if(!check||check.error||!check.mismatches)return null;
 const hard=check.mismatches.filter(m=>!m.soft);const detail=`Whisper nghe: “${check.heard??''}”`;
 if(!hard.length)return {tone:'ok',label:'Khớp kịch bản',detail};
 // The engine sometimes loops at the end: Whisper then hears the sentence's last words again, once or more, as one extra span at the
 // very end. That span is a loop when it continues the p words before it (1 <= p <= its length), i.e. the heard text ends periodically.
 const last=hard.at(-1)!,extra=wordTokens(last.heard),heard=wordTokens(check.heard??''),n=extra.length,L=heard.length;
 const looped=!last.expected&&n>0&&L>n&&extra.every((w,i)=>w===heard[L-n+i])&&extra.some((_,k)=>L>=n+k+1&&extra.every((_,i)=>heard[L-n+i]===heard[L-n+i-k-1]));
 if(looped)return {tone:'warn',label:'Giọng lặp lại cuối câu: tạo lại take',detail:`${detail} Cuối take, giọng đọc lặp lại “${last.heard}”. Bấm “Tạo take mới” để đọc lại đoạn này.`};
 return {tone:'warn',label:`Có thể đọc sai: ${hard.slice(0,2).map(m=>`“${m.expected||'…'}” → “${m.heard||'…'}”`).join(', ')}${hard.length>2?` +${hard.length-2}`:''}`,detail};
}
/** Speaker choices for a row: every speaker in the transcript plus one new one. */
export function speakerSlots(rows:TranscriptSegment[]):number{let top=-1;for(const r of rows)top=Math.max(top,r.speaker??-1);return top+2;} // a loop: spreading 200k rows into Math.max overflows the stack
/** Script lines from a transcript: consecutive rows of one speaker are joined (up to `max` characters). */
export function transcriptToScript(rows:TranscriptSegment[],max=500):{speaker:string;text:string;cue_start_ms:number;cue_end_ms:number}[]{
 const out:{speaker:string;text:string;cue_start_ms:number;cue_end_ms:number}[]=[];
 for(const r of rows){const text=r.text.trim();if(!text)continue;const speaker=r.speaker===undefined?'Người dẫn':`Người ${r.speaker+1}`;const last=out.at(-1);
  if(last&&last.speaker===speaker&&last.text.length+1+text.length<=max){last.text+=' '+text;last.cue_end_ms=r.end_ms;}else out.push({speaker,text,cue_start_ms:r.start_ms,cue_end_ms:r.end_ms});}
 return out;
}
/** The transcript row being heard at `ms` of the source audio, if any. */
/** Class of waveform bar `i` of `n`: outside the trim window, already played, or neither. */
export function barState(i:number,n:number,durationMs:number,trim:{trim_start_ms:number;trim_end_ms:number|null},playMs:number|null):''|'trimmed'|'played'{
 const t=(i+0.5)/n*durationMs;
 if(t<trim.trim_start_ms||t>(trim.trim_end_ms??durationMs))return 'trimmed';
 return playMs!==null&&t<=playMs?'played':'';
}
export const rowAt=(rows:TranscriptSegment[],ms:number)=>rows.find(r=>r.start_ms<=ms&&ms<r.end_ms)?.id??null;
/** Pause mark the worker turns into silence: "[nghỉ 0.5s]", "[nghỉ 300ms]", "[pause 2 sec]", bare "[nghỉ]" = 1 s. Any bracket opening with nghỉ or pause matches, and nghi only when bare or followed by a digit (so "[nghi ngờ]" stays text); one that does not parse is dropped by the worker (worker/main.py PAUSE_MARK). */
const PAUSE_MARK=/\[\s*(?:(?:nghỉ|pause)(?![\p{L}\p{N}_])[^\]]*|nghi\s*(?:\d[^\]]*)?)\]/giu;
/** Non-verbal cue the engine turns into an emotion token (experimental): the spellings its phonemizer accepts, which must reach it unchanged. */
const CUE_MARK=/\[\s*(?:chuckle|cười|cuoi|sigh|thở dài|tho dai|clear throat|hắng giọng|hang giong)\s*\]/giu;
export const spokenText=(text:string)=>text.replace(PAUSE_MARK,' ').replace(CUE_MARK,' ').replace(/\s+/g,' ').trim();
/** Insert `tag` over [start,end), with a space on each side when it would touch a word. */
export function insertAtCursor(text:string,start:number,end:number,tag:string):{text:string;caret:number} {
 const from=Math.max(0,Math.min(start,text.length)),to=Math.max(from,Math.min(end,text.length)),before=text.slice(0,from),after=text.slice(to);
 const inserted=`${before&&!/\s/.test(before.slice(-1))?' ':''}${tag}${after&&/\s/.test(after[0])?'':' '}`;
 return {text:before+inserted+after,caret:before.length+inserted.length};
}
/** Dictionary and number rules apply to spoken text only; pause marks and cues pass through untouched. `codeSwitch` wraps English-only words in <en>…</en>. */
export function normalizeText(text:string,dictionary:Record<string,string>,options:{codeSwitch?:boolean}={}):string {
 return text.normalize('NFC').split(new RegExp(`(${PAUSE_MARK.source}|${CUE_MARK.source})`,'iu')).map((part,i)=>i%2?part:normalizeSpoken(part,dictionary,options.codeSwitch)).join('');
}
/** normalizeText's output cut into parts that join back to it byte for byte, for display: a word no longer in the input (by a longest
 * common subsequence of whitespace-separated words) is `changed`, and `rule` names the dictionary entries whose reading it holds.
 * `tooLong`: the changed stretch was too long to align, so nothing is marked. */
export function normalizedParts(text:string,dictionary:Record<string,string>,options:{codeSwitch?:boolean}={}):{parts:{text:string;changed:boolean;rule?:string}[];tooLong:boolean}{
 const out=normalizeText(text,dictionary,options),src=text.normalize('NFC').split(/\s+/).filter(Boolean),tokens=out.split(/(\s+)/),at=tokens.flatMap((t,i)=>i%2||!t?[]:[i]),word=(j:number)=>tokens[at[j]],n=src.length,m=at.length,changed=new Set(at);
 // Words both ends share are kept before the LCS, so a long segment with its changes near one end stays cheap.
 let a=0,b=0;while(a<n&&a<m&&src[a]===word(a))changed.delete(at[a++]);while(b<n-a&&b<m-a&&src[n-1-b]===word(m-1-b))changed.delete(at[m-1-b++]);
 const N=n-a-b,M=m-a-b,tooLong=N*M>4e6;
 if(!tooLong){ // shortcut: a very long changed stretch is shown without highlights (the inspector says so)
  const L=new Int32Array((N+1)*(M+1)),ix=(i:number,j:number)=>i*(M+1)+j;
  for(let i=N-1;i>=0;i--)for(let j=M-1;j>=0;j--)L[ix(i,j)]=src[a+i]===word(a+j)?L[ix(i+1,j+1)]+1:Math.max(L[ix(i+1,j)],L[ix(i,j+1)]);
  for(let i=0,j=0;i<N&&j<M;)if(src[a+i]===word(a+j)){changed.delete(at[a+j]);i++;j++;}else if(L[ix(i+1,j)]>=L[ix(i,j+1)])i++;else j++;
 }else changed.clear();
 const re=dictionaryRegex.get(dictionary),used=[...new Set(re?text.normalize('NFC').match(re):[])].filter(k=>dictionary[k]),parts:{text:string;changed:boolean;rule?:string}[]=[];
 // Spaces between two changed words belong to the same highlight.
 tokens.forEach((t,i)=>{if(!t)return;const c=i%2?changed.has(i-1)&&changed.has(i+1):changed.has(i),last=parts.at(-1);if(last?.changed===c)last.text+=t;else parts.push({text:t,changed:c});});
 for(const p of parts){const keys=p.changed?used.filter(k=>p.text.includes(dictionary[k])):[];if(keys.length)p.rule=keys.map(k=>`“${k}” → “${dictionary[k]}”`).join(', ');}
 return {parts,tooLong};
}
const CURRENCY:Record<string,string>={'₿':'bitcoin','₹':'rupi','₽':'rúp','¢':'xu'};
// Code-switching idea ported from nguyenan97/VieNeu-TTS commit c836e480 (src/vieneu_utils/codeswitch.py, Apache-2.0): pinned sea-g2p reads <en>…</en> with its English engine.
// Its ALL-CAPS rule is left out: it needs sea-g2p's English word list, and without it UBND/THPT would be read as English.
const EN_TOKEN=/(<en>[\s\S]*?<\/en>|\[[^\]]*\]|<\|[^|]*\|>|\S*(?::\/\/|@|www\.|[\\/])\S*|\S*[A-Za-z0-9]\.[A-Za-z]\S*)|(?<![\p{L}\p{N}])[A-Za-z]{2,}(?:['’][A-Za-z]+)*(?![\p{L}\p{N}])/gu;
// Unaccented Vietnamese syllables end in a vowel, m, n, ng or nh (p/t/c/ch codas need a tone mark) and never contain f/j/w/z; all-caps and vowel-less words are acronyms or units.
const onlyEnglish=(w:string)=>w!==w.toUpperCase()&&/[aeiouy]/i.test(w)&&(/[fjwz]/i.test(w)||!/(?:[aeiouymn]|ng|nh)$/i.test(w));
// Only sentences typed with diacritics, so Vietnamese written without them ("hoc", "dep") is left alone.
const tagEnglish=(text:string)=>text.split(/(?<=[.!?…])(\s+)/u).map((s,i)=>i%2||!/\p{M}|đ/iu.test(s.normalize('NFD'))?s:s.replace(EN_TOKEN,(m,kept)=>kept||!onlyEnglish(m)?m:`<en>${m}</en>`)).join('').replace(/<\/en>(\s+)<en>/g,'$1');
// Book text the engine reads aloud ("một," for [1], "sao sao sao" for ***): a numeric footnote [1] right after a letter, digit or punctuation (a lone [1] is kept), superscript digits except the ² and ³ of units like m² and cm³, and lines that are only a scene break. Footnote idea after bunyu/VieNeu-TTS 1dd0a8d0 VietnameseText.kt (Apache-2.0).
// A scene break is dropped, not turned into [nghỉ]: the worker rejects a segment of nothing but a pause, and the 300 ms gap between segments already separates the scenes.
const SCENE_BREAK=/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|⁂)[ \t\r]*$/u;
const stripBook=(s:string)=>s.replace(new RegExp(SCENE_BREAK.source,'gmu'),'').replace(/(?<=[\p{L}\p{N}.,;:!?"'”’…)])\[\d{1,3}\]/gu,'').replace(/[¹⁰⁴-⁹]|(?<!(?<![\p{L}\p{M}])[kcdm]?m)[²³]/gu,'');
// Markup the engine reads aloud ("sao sao", "thăng", "nhỏ hơn font"): Markdown bold, headings and quotes at a line start, links (the text stays), HTML/subtitle tags other than our <en>, ASS overrides such as {\an8}, and ♪.
const stripMarkup=(s:string)=>stripBook(s).replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/gu,'$1').replace(/^[ \t]*(?:#{1,6}|>)[ \t]+/gmu,'').replace(/\[([^\]\n]+)\]\((?:https?:|www\.)[^)\s]*\)/gu,'$1').replace(/<\/?(?!en>)[a-z][^<>]*>/giu,' ').replace(/\{\\[^}]*\}|♪/gu,' ');
// Whole words only, so "AI" leaves "OpenAI" alone; a key that starts or ends with punctuation ("TP.", "đ/cp") is bounded on its letter side only.
const WORD='[\\p{L}\\p{M}\\p{N}]',bounded=(k:string)=>`${/^[\p{L}\p{M}\p{N}]/u.test(k)?`(?<!${WORD})`:''}${escapeRegExp(k)}${/[\p{L}\p{M}\p{N}]$/u.test(k)?`(?!${WORD})`:''}`;
// Compiled once per dictionary object (5,000 keys take ~3 ms); dictionaries are replaced on every change, never edited in place.
const dictionaryRegex=new WeakMap<Record<string,string>,RegExp|null>();
function normalizeSpoken(text:string,dictionary:Record<string,string>,codeSwitch=false):string {
 let re=dictionaryRegex.get(dictionary);if(re===undefined){const keys=Object.keys(dictionary).filter(Boolean).sort((a,b)=>b.length-a.length);re=keys.length?new RegExp(keys.map(bounded).join('|'),'gu'):null;dictionaryRegex.set(dictionary,re);}
 let out=stripMarkup(text.normalize('NFC'));
 if(re)out=out.replace(re,m=>dictionary[m]);
 out=out.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,(_,d,m,y)=>`${Number(d)} tháng ${Number(m)} năm ${y}`).replace(/(\d[\d.,]*)\s*(₫|đ)(?=\s|[.,;!?]|$)/g,(_,n)=>`${n.replace(/\./g,'')} đồng`).replace(/\b(\d+(?:[.,]\d+)?)\s*kg\b/gi,'$1 ki lô gam').replace(/\b(\d+(?:[.,]\d+)?)\s*km\b/gi,'$1 ki lô mét')
  // Readings pinned sea-g2p 0.10.0 gets wrong (its issues #20, #21, #22, #25): đ/cp → "địa chỉp", -2,5 loses the sign, 50k → "năm mươi ca", 1.2B → "bê", rate 1.1200 → a date, ₿₹₽¢ dropped.
  .replace(/(?<!\p{L})(\d?)\s*đ\/(c\p{L}+)/gu,(_,d,u)=>`${d&&d+' '}đồng trên ${u==='cp'?'cổ phiếu':u}`).replace(/(?<![\p{L}\d])[-\u2212](?=\d+,\d)/gu,'âm ').replace(/(?<![\p{L}\d.,])(\d[\d.,]*)k(?![\p{L}\d])/gu,'$1 nghìn').replace(/(?<![\p{L}\d.,])(\d+)[.,](\d+)B(?![\p{L}\d])/gu,'$1,$2 tỷ')
  .replace(/(?<![\d.,])(\d{1,2})\.(\d{4})(?!\d|[.,]\d)/g,(m,a,b)=>+a>=1&&+a<=12&&(+b<1900||+b>2100)?`${a} chấm ${[...b].join(' ')}`:m).replace(/([₿₹₽¢])\s*(\d(?:[\d.,]*\d)?)|(\d(?:[\d.,]*\d)?)\s*([₿₹₽¢])/gu,(_,s,a,b,t)=>`${a??b} ${CURRENCY[s??t]}`);
 return codeSwitch?tagEnglish(out):out;
}
const SENTENCE_END=/(?<=[.!?…]["'”’)\]]*)\s+/gu;
function splitWords(text:string,max:number):string[]{const out:string[]=[];let current='';for(const word of text.split(/\s+/)){if(!word)continue;if(current.length+word.length+1>max&&current){out.push(current);current='';}if(word.length>max){if(current)out.push(current);for(let i=0;i<word.length;i+=max)out.push(word.slice(i,i+max));current='';}else current+=(current?' ':'')+word;}if(current)out.push(current);return out;}
// Each line is its own paragraph; sentences are packed up to max chars and only a single over-long sentence is cut (at word boundaries).
export function splitText(input:string,max=500):string[]{const out:string[]=[];for(const para of input.trim().split(/\n+/)){let current='';for(const sentence of para.trim().replace(/\s+/g,' ').split(SENTENCE_END)){if(!sentence)continue;if(current&&current.length+1+sentence.length<=max){current+=' '+sentence;continue;}if(current)out.push(current);if(sentence.length<=max)current=sentence;else{const parts=splitWords(sentence,max);current=parts.pop()!;out.push(...parts);}}if(current)out.push(current);}return out;}
/** Trim for a take: its speech edges as the worker found them; the whole take when it has none (older takes) or when the segment's fades (`fade_ms`, in + out) would not fit inside them. */
export function takeTrim(take?:Take,fade_ms=0){const start=take?.speech_start_ms??0,end=take?.speech_end_ms??null;return take&&(end??take.duration_ms)-start>=fade_ms?{trim_start_ms:start,trim_end_ms:end}:{trim_start_ms:0,trim_end_ms:null};}
export function makeSegment(text=''):Segment{return {id:uid(),text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};}
// A line "Tên: lời" or "[Tên]: lời" names its speaker. The name is at most 30 characters with no digits or URL (so "8:30" and "http://…" are not labels),
// except the app's own "Người 2: …", which a TXT export of a transcript with speakers writes: in either Unicode spelling and only with a
// space after the colon, so "Người 8:30 sáng" stays text.
const OWN_LABEL=/^\s*\[?Người \d{1,3}\]?\s*[:：]\s/u;
const LABEL=/^\s*(?:\[([^\][:\n]+)\]|([^:[\]\n]+?))\s*[:：](?!\/\/)\s*(.*)$/u;
// A line starting with [P1] (any case, spaces allowed inside) starts a chapter; the rest of the line is ordinary script text.
const CHAPTER=/^\s*\[\s*P(\d+)\s*\](.*)$/i;
const labelOf=(line:string)=>{const m=line.match(LABEL),name=(m?.[1]??m?.[2])?.trim();if(!m||!name||name.length>30)return null;if(!/\d|www\.|@/i.test(name))return {name,rest:m[3]};return OWN_LABEL.test(line.normalize('NFC'))?{name:name.normalize('NFC'),rest:m[3]}:null;};
/** Script chunks of pasted text. With at least two labelled lines each label starts a block (continuing until the next label) spoken by that name; otherwise one speaker reads everything, so a lone "Lưu ý:" stays text. */
export function scriptChunks(text:string):{speaker:string;text:string;chapter?:string}[]{
 const lines=text.split(/\r?\n/).filter(l=>!SCENE_BREAK.test(l)).map(raw=>{
  // "[P1] text" or "[P1]: text", or the marker right after a speaker label: "Lan: [P1] text"
  const m=raw.match(CHAPTER);let line=m?m[2].replace(/^\s*[:：]/,'').trim():raw,label=labelOf(line),chapter=m?`P${m[1]}`:undefined;
  const after=!chapter&&label?label.rest.match(CHAPTER):null;
  if(after&&label){chapter=`P${after[1]}`;label={...label,rest:after[2].trim()};line=raw.replace(/\[\s*P\d+\s*\]\s*/i,'');}
  return {line,label,chapter};
 }),labelled=lines.filter(l=>l.label).length>=2,blocks=[{speaker:'Người dẫn',lines:[] as string[],chapter:undefined as string|undefined}];
 for(const {line,label,chapter} of lines){if(labelled&&label)blocks.push({speaker:label.name,lines:[label.rest],chapter});else if(chapter)blocks.push({speaker:blocks.at(-1)!.speaker,lines:[line],chapter});else blocks.at(-1)!.lines.push(line);}
 let pending:string|undefined;// a marker with no text yet waits for the next chunk
 return blocks.flatMap(b=>{pending=b.chapter??pending;const texts=splitText(b.lines.join('\n'));if(!texts.length)return [];const chapter=pending;pending=undefined;return texts.map((text,i)=>({speaker:b.speaker,text,...(i===0&&chapter&&{chapter})}));});
}
/** Chapter label of a segment ('' when it starts none). */
export const chapterOf=(s:Segment)=>s.chapter?.trim()||'';
/** Chapters of a script: a segment belongs to the nearest chapter start at or before it; segments before the first start form `P0`. Empty when no segment starts a chapter. */
export function chapterGroups(segments:Segment[]):{label:string;segments:Segment[]}[]{
 if(!segments.some(chapterOf))return [];
 const groups:{label:string;segments:Segment[]}[]=[];
 for(const s of segments){if(chapterOf(s)||!groups.length)groups.push({label:chapterOf(s)||'P0',segments:[s]});else groups.at(-1)!.segments.push(s);}
 return groups;
}
/** Job and file name of the n-th chapter (1-based): `001-P1`. The label is NFC-normalized and keeps letters, digits, `-` and `_` (spaces become `_`), at most 80 characters. */
export function chapterFileName(order:number,label:string):string{const clean=[...label.normalize('NFC').trim().replace(/\s+/g,'_').replace(/[^\p{L}\p{N}_-]/gu,'')].slice(0,80).join('');return String(order).padStart(3,'0')+(clean?`-${clean}`:'');}
export function splitTranscript(row:TranscriptSegment):[TranscriptSegment,TranscriptSegment]{const words=row.text.split(/\s+/);if(words.length<2||row.end_ms-row.start_ms<2)throw Error('Cần ít nhất hai từ để chia đoạn');const n=Math.ceil(words.length/2);const mid=Math.round(row.start_ms+(row.end_ms-row.start_ms)*n/words.length);return [{...row,text:words.slice(0,n).join(' '),end_ms:mid},{id:uid(),start_ms:mid,end_ms:row.end_ms,text:words.slice(n).join(' '),...(row.speaker!==undefined&&{speaker:row.speaker})}];}
export function mergeTranscript(a:TranscriptSegment,b:TranscriptSegment):TranscriptSegment{return {...a,start_ms:Math.min(a.start_ms,b.start_ms),end_ms:Math.max(a.end_ms,b.end_ms),text:a.text+' '+b.text};}
export interface Recipe {duration_ms:number;trim_start_ms:number;trim_end_ms:number|null;gap_ms:number;fade_in_ms:number;fade_out_ms:number;gain_db:number}
export function validateRecipe(c:Recipe):void {const end=c.trim_end_ms??c.duration_ms;if(![c.duration_ms,c.trim_start_ms,end,c.gap_ms,c.fade_in_ms,c.fade_out_ms,c.gain_db].every(Number.isFinite)||c.trim_start_ms<0||end>c.duration_ms||end<=c.trim_start_ms||c.gap_ms<0)throw Error('Trim và khoảng nghỉ phải nằm trong thời lượng audio');if(c.fade_in_ms<0||c.fade_out_ms<0||c.fade_in_ms+c.fade_out_ms>end-c.trim_start_ms)throw Error('Fade vượt thời lượng đoạn');}
export function clipDuration(c:Recipe):number {validateRecipe(c);return (c.trim_end_ms??c.duration_ms)-c.trim_start_ms+c.gap_ms;}
const splitMarks=(t:string,re:RegExp)=>[...t.matchAll(re)].map(m=>m.index!).filter(i=>t.slice(0,i).trim()&&t.slice(i).trim());
// Split at the cursor when it is inside the text, else at the sentence (then word) boundary closest to the middle. The first half keeps id, takes and recipe.
export function splitSegment(s:Segment,cursor?:number,dictionary:Record<string,string>={}):[Segment,Segment]{
 const t=s.text,mid=t.length/2,closest=(m:number[])=>m.sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid))[0];
 const at=cursor!==undefined&&cursor>0&&cursor<t.length&&t.slice(0,cursor).trim()&&t.slice(cursor).trim()?cursor:closest(splitMarks(t,SENTENCE_END))??closest(splitMarks(t,/\s+/g));
 if(at===undefined)throw Error('Đoạn cần ít nhất hai từ để chia');
 const a=t.slice(0,at).trim(),b=t.slice(at).trim(),cut=s.cue_start_ms!=null&&s.cue_end_ms!=null?Math.round(s.cue_start_ms+(s.cue_end_ms-s.cue_start_ms)*a.length/(a.length+b.length)):undefined;
 return [{...s,text:a,normalized_text:normalizeText(a,dictionary),...(cut!==undefined&&{cue_end_ms:cut})},{...s,id:uid(),chapter:undefined,text:b,...(cut!==undefined&&{cue_start_ms:cut}),normalized_text:normalizeText(b,dictionary),takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0}];
}
export function mergeSegments(a:Segment,b:Segment,dictionary:Record<string,string>={}):Segment{const text=[a.text.trim(),b.text.trim()].filter(Boolean).join(' ');return {...a,text,normalized_text:normalizeText(text,dictionary),gap_ms:b.gap_ms,...(a.cue_start_ms!=null&&a.cue_end_ms!=null&&b.cue_start_ms!=null&&b.cue_end_ms!=null&&{cue_start_ms:Math.min(a.cue_start_ms,b.cue_start_ms),cue_end_ms:Math.max(a.cue_end_ms,b.cue_end_ms)})};}
// Takes are append-only and server-owned: restoring an older snapshot must keep every take of the current project, plus new segments that already own takes.
export function restoreSnapshot(snap:Project,cur:Project):Project{
 const byId=new Map(cur.segments.map(s=>[s.id,s]));
 const segments=snap.segments.map(s=>{const c=byId.get(s.id);if(!c)return s;const known=new Set(s.takes.map(t=>t.id));return {...s,takes:[...s.takes,...c.takes.filter(t=>!known.has(t.id))],...(s.selected_take_id==null&&c.selected_take_id!=null&&{selected_take_id:c.selected_take_id,trim_start_ms:c.trim_start_ms,trim_end_ms:c.trim_end_ms})};});
 const ids=new Set(segments.map(s=>s.id));cur.segments.forEach((s,i)=>{if(!ids.has(s.id)&&s.takes.length)segments.splice(Math.min(i,segments.length),0,s);});
 return {...snap,segments,id:cur.id,name:cur.name,revision:cur.revision,updated_at:cur.updated_at};
}
export const validRange=(start:number,end:number)=>Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start;
export function addTranscriptRow(rows:TranscriptSegment[],afterId:string|null):TranscriptSegment[]{const found=rows.findIndex(r=>r.id===afterId),i=found<0?rows.length-1:found,start_ms=rows[i]?.end_ms??0;return [...rows.slice(0,i+1),{id:uid(),start_ms,end_ms:start_ms+1000,text:''},...rows.slice(i+1)];}
/** A row this long with fewer than SUSPECT_MIN_CPS letters and digits per second is usually Whisper making text up over silence. */
export const SUSPECT_SILENT_MS=4000,SUSPECT_MIN_CPS=2;
export type SuspectReason='silence'|'repeat'|'range';
export const suspectLabel:Record<SuspectReason,{short:string;why:string}>={
 silence:{short:'Gần như im lặng',why:'Đoạn dài nhưng gần như không có chữ. Whisper hay bịa chữ hoặc bỏ trống ở chỗ im lặng.'},
 repeat:{short:'Lặp dòng trước',why:'Nội dung giống hệt dòng ngay trước. Đây thường là lỗi lặp của Whisper.'},
 range:{short:'Sai thời gian',why:'Thời gian kết thúc không lớn hơn thời gian bắt đầu.'}
};
const repeatKey=(s:string)=>s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
/** Rows that look like Whisper mistakes, by row id. Only flags them: nothing is changed or removed. Two different speakers saying the same short line is a conversation, not a loop. */
export function suspiciousRows(rows:TranscriptSegment[]):Map<string,SuspectReason[]>{
 const out=new Map<string,SuspectReason[]>();let before='';
 rows.forEach((r,i)=>{
  const why:SuspectReason[]=[],ms=r.end_ms-r.start_ms,chars=(r.text.match(/[\p{L}\p{N}]/gu)??[]).length;
  if(!(ms>0))why.push('range');else if(ms>=SUSPECT_SILENT_MS&&chars*1000<SUSPECT_MIN_CPS*ms)why.push('silence');
  const key=repeatKey(r.text),prev=rows[i-1];if(key&&key===before&&!(r.speaker!==undefined&&prev?.speaker!==undefined&&r.speaker!==prev.speaker))why.push('repeat');before=key;
  if(why.length)out.set(r.id,why);
 });
 return out;
}
// A running job's updated_at is when it started: progress writes do not touch it.
export function progressLabel(progress:number,startedAt:string,now=Date.now()):string{const pct=`${Math.floor(progress*100)} %`;const elapsed=now-Date.parse(startedAt);if(!(progress>=0.15&&progress<1&&elapsed>0))return pct;return `${pct} · còn ~${Math.max(1,Math.round(elapsed*(1-progress)/progress/60000))} phút`;}
/** Taskbar progress for the job list: nothing while idle, the average of the running jobs (percent) once one reports progress, else indeterminate. */
export function taskbarProgress(jobs:{status:string;progress:number}[]):{status:'none'|'normal'|'indeterminate';progress?:number}{
 const running=jobs.filter(j=>j.status==='running');
 if(!running.length&&!jobs.some(j=>j.status==='queued'))return {status:'none'};
 if(!running.some(j=>j.progress>0))return {status:'indeterminate'};
 return {status:'normal',progress:Math.round(100*running.reduce((n,j)=>n+Math.min(1,Math.max(0,j.progress)),0)/running.length)};
}
// A TTS batch marks all its jobs running but reports progress only for the one being synthesized.
export const jobProgressLabel=(kind:string,progress:number,startedAt:string,now=Date.now())=>kind==='tts'&&progress<=0?'Chờ trong lô':progressLabel(progress,startedAt,now);
// Readable captions: at most 84 characters per cue in two lines of at most 42 (common subtitle limits).
const CUE_CHARS=84,LINE_CHARS=42;
/** Cut text into pieces of at most `max` characters, after punctuation when that keeps at least half a piece, else at the last space; a longer word stays whole. */
function cuePieces(text:string,max=CUE_CHARS):string[]{
 const out:string[]=[];let rest=text.trim();
 while(rest.length>max){const head=rest.slice(0,max+1),punct=Math.max(...[',',';',':','.','!','?'].map(p=>head.lastIndexOf(p+' ')));let cut=punct>=max/2?punct+1:head.lastIndexOf(' ');if(cut<=0)cut=rest.indexOf(' ',max);if(cut<0)break;out.push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();}
 return [...out,rest].filter(Boolean);
}
const wrapCue=(cue:string)=>{if(cue.length<=LINE_CHARS)return cue;let best=-1;for(let i=cue.indexOf(' ');i>=0;i=cue.indexOf(' ',i+1))if(best<0||Math.abs(i-cue.length/2)<Math.abs(best-cue.length/2))best=i;return best<0?cue:`${cue.slice(0,best)}\n${cue.slice(best+1)}`;};
// Dubbing on the subtitle timeline (after cit-voice-studio's dubbing.py): a take starts at its cue and is sped up to fit it, at most
// 1.5x; one that still runs over pushes the next take back (at least 50 ms between them). Words are never cut. A segment without a
// cue follows the previous take after that take's gap.
const MAX_FIT_RATE=1.5,DUB_GAP_MS=50;
interface DubCue {cue_start_ms?:number|null;cue_end_ms?:number|null}
/** Where each take starts on the timeline, its speed-up, where it ends and how far it still runs past its cue at 1.5x (`over_ms`); counts of sped-up and pushed takes; the total length (at least the last cue's end). */
export function dubPlan(clips:(Recipe&DubCue)[]):{places:{at_ms:number;rate:number;end_ms:number;over_ms:number}[];sped_up:number;pushed:number;max_push_ms:number;length_ms:number}{
 let cursor=0,gap=0,sped_up=0,pushed=0,max_push_ms=0;
 const places=clips.map((c,i)=>{const audio=clipDuration(c)-c.gap_ms;let at=cursor+(i?gap:0),rate=1,over=0;
  if(c.cue_start_ms!=null&&c.cue_end_ms!=null){const slot=c.cue_end_ms-c.cue_start_ms;if(audio>slot)rate=slot>0?Math.min(MAX_FIT_RATE,audio/slot):MAX_FIT_RATE;at=Math.max(c.cue_start_ms,i?cursor+DUB_GAP_MS:0);over=Math.max(0,Math.round(audio/rate-slot));
   if(rate>1)sped_up++;if(at-c.cue_start_ms>5){pushed++;max_push_ms=Math.max(max_push_ms,at-c.cue_start_ms);}}
  cursor=at+audio/rate;gap=c.gap_ms;return {at_ms:Math.round(at),rate,end_ms:Math.round(cursor),over_ms:over};});
 return {places,sped_up,pushed,max_push_ms:Math.round(max_push_ms),length_ms:Math.round(Math.max(cursor,...clips.map(c=>c.cue_end_ms??0)))};
}
/** The segments with their selected take's length, or null while one has no selected take. */
function dubClips(segments:Segment[]):(Segment&{duration_ms:number})[]|null{const clips=segments.map(s=>{const t=s.takes.find(t=>t.id===s.selected_take_id);return t&&{...s,duration_ms:t.duration_ms};});return clips.length&&clips.every(c=>!!c)?clips as (Segment&{duration_ms:number})[]:null;}
/** One line on how the takes fit their cues, for the export bar; empty when a segment has no selected take yet. It runs while rendering, so a trim or fade being typed in must not throw. */
export function dubSummary(segments:Segment[]):string{
 const clips=dubClips(segments);if(!clips)return '';
 let r:ReturnType<typeof dubPlan>;try{r=dubPlan(clips);}catch(e){return e instanceof Error?e.message:'';}
 const secs=(r.max_push_ms/1000).toLocaleString('vi-VN',{maximumFractionDigits:2});
 return `${r.sped_up} đoạn đọc nhanh hơn · ${r.pushed} đoạn bị lùi${r.pushed?` (tối đa ${secs} s)`:''}`;
}
/** How many ms each take still runs past its cue at 1.5x, by segment id; empty while a take is missing or a recipe is invalid (dubSummary says why). */
export function dubOverruns(segments:Segment[]):Map<string,number>{
 const clips=dubClips(segments),out=new Map<string,number>();if(!clips)return out;
 try{dubPlan(clips).places.forEach((p,i)=>{if(p.over_ms>0)out.set(clips[i].id,p.over_ms);});}catch{/* dubSummary shows the reason */}return out;
}
/** Lowercase words of a script or of what Whisper heard, for matching the two. */
const wordTokens=(text:string)=>text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
/** Matches script words to heard words in order (longest common subsequence): for each script word the index of its heard word token, or -1, and every heard token's start (ms). */
export function matchWords(script:string[],heard:{text:string;start_ms:number}[]):{match:number[];starts:number[]}{
 const h=heard.flatMap(w=>wordTokens(w.text).map(t=>[t,w.start_ms] as const)),n=script.length,m=h.length,match:number[]=Array(n).fill(-1),starts=h.map(x=>x[1]);
 if(!n||!m||n*m>4e6)return {match,starts}; // shortcut: a very long segment keeps character-count timing
 const L=new Int32Array((n+1)*(m+1)),at=(i:number,j:number)=>i*(m+1)+j;
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)L[at(i,j)]=script[i]===h[j][0]?L[at(i+1,j+1)]+1:Math.max(L[at(i+1,j)],L[at(i,j+1)]);
 for(let i=0,j=0;i<n&&j<m;)if(script[i]===h[j][0])match[i++]=j++;else if(L[at(i+1,j)]>=L[at(i,j+1)])i++;else j++;
 return {match,starts};
}
/** Subtitle rows for the rendered takes: each segment's text in readable cues; a cue starts where the self-check heard its first word (`words`, take time) and the other cue edges share the time between those by character count; with `dub`, at the takes' places on the subtitle timeline, each shown at least as long as its cue. */
export function ttsTranscript(clips:(Recipe&DubCue&{text:string;words?:{text:string;start_ms:number}[]})[],dub=false):TranscriptSegment[]{let time=0;const plan=dub?dubPlan(clips).places:null;return clips.flatMap((c,i)=>{let start=time;time+=clipDuration(c);let end=time-c.gap_ms;if(plan){start=plan[i].at_ms;end=Math.min(plan[i+1]?.at_ms??Infinity,Math.max(plan[i].end_ms,start+(c.cue_end_ms??0)-(c.cue_start_ms??0)));}
 const cues=cuePieces(spokenText(c.text)),total=cues.reduce((n,q)=>n+q.length,0),tokens=cues.map(wordTokens),{match,starts}=matchWords(c.words?.length?tokens.flat():[],c.words??[]),rate=plan?.[i].rate??1,share=(end-start)/total/2;
 // [characters before a cue, its start]: the segment's edges and the measured cue starts. A cue's first word counts only when
 // a neighbouring word matched the neighbouring heard word too (a lone match may be the same word elsewhere), and only when
 // the cues before and after it keep at least half the time their characters would get. A misheard first word ("hy" heard as
 // "hi") is the one unmatched heard word between a matched word and the cue's next two words.
 const anchors:[number,number][]=[[0,start]];let chars=0,k=0;
 cues.forEach((q,n)=>{const f=k,next=match[f+1]??-1,misheard=match[f]<0&&tokens[n].length>2&&next>0&&match[f+2]===next+1&&!match.includes(next-1)&&(next===1||match.includes(next-2)),j=misheard?next-1:match[f];k+=tokens[n].length;
  if(n&&tokens[n].length&&j>=0&&(match[f+1]===j+1||match[f-1]===j-1)){const t=start+(starts[j]-c.trim_start_ms)/rate,[c0,t0]=anchors[anchors.length-1];if(t-t0>=(chars-c0)*share&&end-t>=(total-chars)*share)anchors.push([chars,t]);}
  chars+=q.length;});
 anchors.push([total,end]);
 const timeAt=(ch:number)=>{const z=anchors.findIndex(a=>a[0]>=ch),[c0,t0]=anchors[z-1]??anchors[z],[c1,t1]=anchors[z];return c1===c0?t1:t0+(t1-t0)*(ch-c0)/(c1-c0);};
 let at=start;chars=0;return cues.map(q=>{const start_ms=at;chars+=q.length;at=Math.round(timeAt(chars));return {id:uid(),start_ms,end_ms:at,text:wrapCue(q)};});});}
/** Value equality of JSON data such as IPC answers; key order does not matter. */
export function jsonEqual(a:unknown,b:unknown):boolean{if(a===b)return true;if(typeof a!=='object'||typeof b!=='object'||!a||!b||Array.isArray(a)!==Array.isArray(b))return false;const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=Object.keys(x);return keys.length===Object.keys(y).length&&keys.every(k=>Object.hasOwn(y,k)&&jsonEqual(x[k],y[k]));}
