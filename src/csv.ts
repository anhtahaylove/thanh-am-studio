// Pronunciation dictionary as CSV: two columns (original word, how to read it) with a header row.
const HEADER=['Từ gốc','Cách đọc'];
const HEADER_NAMES=[['từ gốc','tu goc','word','original'],['cách đọc','cach doc','reading','pronunciation']];
// The app settings backend rejects keys or values over 512 bytes.
const MAX_BYTES=512;
export const UTF8_HINT='Tệp CSV cần mã hóa UTF-8. Trong Excel, chọn Lưu dưới dạng › CSV UTF-8.';
export interface CsvRecord {line:number;cells:string[];bad?:boolean}
/** RFC 4180 records with the physical line each one starts on. A record is bad when a quote is unclosed or followed by text. */
export function parseCsv(text:string,sep=','):CsvRecord[]{
 const out:CsvRecord[]=[];const n=text.length;let i=0,line=1;
 const end=()=>i>=n||text[i]===sep||text[i]==='\r'||text[i]==='\n';
 while(i<n){
  const rec:CsvRecord={line,cells:[]};
  for(;;){
   let cell='';
   if(text[i]==='"'){
    i++;let closed=false;
    while(i<n){const c=text[i++];if(c==='"'){if(text[i]==='"'){cell+='"';i++;}else{closed=true;break;}}else{if(c==='\n')line++;cell+=c;}}
    if(!closed)rec.bad=true;
    while(!end()){rec.bad=true;i++;}
   }else while(!end())cell+=text[i++];
   rec.cells.push(cell);
   if(i<n&&text[i]===sep){i++;continue;}
   break;
  }
  if(text[i]==='\r')i++;if(text[i]==='\n')i++;line++;
  out.push(rec);
 }
 return out;
}
const clean=(s:string)=>s.normalize('NFC').replace(/\s+/g,' ').trim();
const isHeader=(cells:string[])=>HEADER_NAMES.every((names,i)=>names.includes((cells[i]??'').toLocaleLowerCase('vi')));
/** Reads a dictionary CSV: comma or semicolon (Excel in a Vietnamese locale), header optional, BOM and CRLF allowed. Empty lines are ignored; malformed ones are reported by line number. A later duplicate wins; a file with no usable line throws. */
export function parseDictionaryCsv(text:string):{entries:Record<string,string>;skipped:number[]}{
 if(text.includes('�'))throw Error(UTF8_HINT);
 text=text.replace(/^﻿/,'');
 const first=(text.match(/^.*\S.*$/m)?.[0]??'').replace(/"(?:[^"]|"")*"/g,'');
 const sep=first.split(';').length>first.split(',').length?';':',';
 const entries=new Map<string,string>(),skipped:number[]=[],bytes=(s:string)=>new TextEncoder().encode(s).length;let seen=false;
 for(const rec of parseCsv(text,sep)){
  const cells=rec.cells.map(clean);if(!cells.some(Boolean))continue;
  const header=!seen&&isHeader(cells);seen=true;if(header)continue;
  const [key,value,...rest]=cells;
  if(rec.bad||!key||!value||rest.some(Boolean)||bytes(key)>MAX_BYTES||bytes(value)>MAX_BYTES)skipped.push(rec.line);else entries.set(key,value);
 }
 if(!entries.size)throw Error(`Không đọc được mục nào. Mỗi dòng cần hai cột: từ gốc và cách đọc${skipped.length?` (lỗi ở dòng ${skipped.slice(0,5).join(', ')}${skipped.length>5?'…':''})`:''}.`);
 return {entries:Object.fromEntries(entries),skipped};
}
const quote=(s:string)=>/[",;\r\n]|^\s|\s$/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
/** UTF-8 BOM so Excel shows Vietnamese correctly; comma separated with CRLF line ends. */
export const dictionaryToCsv=(dictionary:Record<string,string>)=>'﻿'+[HEADER,...Object.entries(dictionary)].map(r=>r.map(quote).join(',')).join('\r\n')+'\r\n';
/** Imported entries replace the same key. Counts only real changes. */
export function mergeDictionary(current:Record<string,string>,incoming:Record<string,string>):{dictionary:Record<string,string>;added:number;updated:number}{
 let added=0,updated=0;
 for(const [k,v] of Object.entries(incoming)){if(!Object.hasOwn(current,k))added++;else if(current[k]!==v)updated++;}
 return {dictionary:{...current,...incoming},added,updated};
}
/** Result message; line numbers are listed when there are at most five bad lines. */
export function importSummary(added:number,updated:number,skipped:number[]):string{
 const lines=skipped.length?`, bỏ qua ${skipped.length} dòng không hợp lệ${skipped.length<=5?` (dòng ${skipped.join(', ')})`:''}`:'';
 return added||updated?`Đã nhập CSV: thêm ${added}, cập nhật ${updated}${lines}.`:`Từ điển không thay đổi${lines}.`;
}
