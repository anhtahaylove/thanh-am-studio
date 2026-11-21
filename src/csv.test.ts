import {describe,it,expect} from 'vitest';
import {parseCsv,parseDictionaryCsv,dictionaryToCsv,mergeDictionary,importSummary,UTF8_HINT,ANSI_HINT} from './csv';
describe('dictionary CSV',()=>{
 it('reads RFC 4180 quotes, doubled quotes and embedded separators and newlines',()=>{
  expect(parseCsv('a,"b, c"\r\n"say ""hi""","x\ny"\r\nlast,1')).toEqual([{line:1,cells:['a','b, c']},{line:2,cells:['say "hi"','x\ny']},{line:4,cells:['last','1']}]);
 });
 it('marks unclosed quotes and text after a closing quote as bad',()=>{
  expect(parseCsv('"a"b,c\n"open,d')).toEqual([{line:1,cells:['a','c'],bad:true},{line:2,cells:['open,d'],bad:true}]);
 });
 it('reads a BOM, CRLF file with our header',()=>{
  expect(parseDictionaryCsv('﻿Từ gốc,Cách đọc\r\nTP.HCM,Thành phố Hồ Chí Minh\r\n"AI, ML","trí tuệ nhân tạo, học máy"\r\n')).toEqual({entries:{'TP.HCM':'Thành phố Hồ Chí Minh','AI, ML':'trí tuệ nhân tạo, học máy'},skipped:[]});
 });
 it('reads semicolons from Excel in a Vietnamese locale and a file without header',()=>{
  expect(parseDictionaryCsv('\n\nUBND;Ủy ban nhân dân\nkg;ki lô gam;\n').entries).toEqual({UBND:'Ủy ban nhân dân',kg:'ki lô gam'});
  expect(parseDictionaryCsv('"a;b",c').entries).toEqual({'a;b':'c'});
 });
 it('skips malformed lines with their line numbers, ignores empty ones and lets a later duplicate win',()=>{
  const r=parseDictionaryCsv('word,reading\nGPU,gờ pê u\n\nchỉ một cột\nx,y,z\n,trống\n"mở ngoặc,abc\n');
  expect(r).toEqual({entries:{GPU:'gờ pê u'},skipped:[4,5,6,7]});
  expect(parseDictionaryCsv('a,1\na,2').entries).toEqual({a:'2'});
 });
 it('normalizes Unicode and whitespace and rejects entries the backend would refuse',()=>{
  expect(parseDictionaryCsv('Huè,  huể  \nlong,'+'x'.repeat(513)+'\n').entries).toEqual({'Huè':'huể'});
 });
 it('throws a clear error when nothing is usable or the file is not UTF-8',()=>{
  expect(()=>parseDictionaryCsv('Từ gốc,Cách đọc\n')).toThrow('Không đọc được mục nào');
  expect(()=>parseDictionaryCsv('a\nb')).toThrow('dòng 1, 2');
  expect(()=>parseDictionaryCsv('T� g�c,x')).toThrow(UTF8_HINT);
 });
 it('writes BOM, header and quoted fields that read back unchanged',()=>{
  const d={'TP.HCM':'Thành phố Hồ Chí Minh','5"':'năm inch','a,b':'x;y',['__proto__']:'p'};
  const csv=dictionaryToCsv(d);
  expect(csv.startsWith('﻿Từ gốc,Cách đọc\r\nTP.HCM,Thành phố Hồ Chí Minh\r\n"5""",năm inch\r\n"a,b","x;y"\r\n')).toBe(true);
  expect(parseDictionaryCsv(csv).entries).toEqual(d);
 });
 it('merges by key and counts only real changes',()=>{
  expect(mergeDictionary({a:'1',b:'2',constructor:'c'},{b:'3',c:'4',a:'1',constructor:'c'})).toEqual({dictionary:{a:'1',b:'3',c:'4',constructor:'c'},added:1,updated:1});
 });
 it('summarizes the result in Vietnamese with line numbers only when few',()=>{
  expect(importSummary(2,1,[4])).toBe('Đã nhập CSV: thêm 2, cập nhật 1, bỏ qua 1 dòng không hợp lệ (dòng 4).');
  expect(importSummary(1,0,[1,2,3,4,5,6])).toBe('Đã nhập CSV: thêm 1, cập nhật 0, bỏ qua 6 dòng không hợp lệ.');
  expect(importSummary(0,0,[])).toBe('Từ điển không thay đổi.');
 });
 it('detects Excel plain CSV where Vietnamese letters became question marks',()=>{
  expect(()=>parseDictionaryCsv('T? g?c,C?ch ??c\nHa N?i,Ha Noi')).toThrow(ANSI_HINT);
  expect(()=>parseDictionaryCsv('ng??i,nguoi')).toThrow(ANSI_HINT);
  expect(()=>parseDictionaryCsv('H? N?i;Ha Noi')).toThrow(ANSI_HINT);
  expect(ANSI_HINT).toContain('CSV UTF-8');
 });
 it('does not mistake a real question mark for lost letters',()=>{
  expect(parseDictionaryCsv('gì?,gờ i hỏi\n?,dấu hỏi\nok? yes,ô kê\nBạn khỏe không?,hỏi thăm\nwhy??,tại sao').entries).toEqual({'gì?':'gờ i hỏi','?':'dấu hỏi','ok? yes':'ô kê','Bạn khỏe không?':'hỏi thăm','why??':'tại sao'});
  expect(parseDictionaryCsv('a.com?id=3,đây là đường dẫn').entries).toEqual({'a.com?id=3':'đây là đường dẫn'});expect(parseDictionaryCsv('Hả?Gì,hỏi lại\nok?Yes,ô kê\nx?foo&bar=1,đường dẫn').entries).toEqual({'Hả?Gì':'hỏi lại','ok?Yes':'ô kê','x?foo&bar=1':'đường dẫn'});
 });
 it('keeps cells Excel would convert as text and defuses formulas on export',()=>{
  const d={'1/2':'một phần hai','007':'không không bảy','2.0':'hai chấm không','1-2':'một đến hai','1e5':'một e năm','12:30':'mười hai giờ ba mươi','=SUM(A1)':'x','+1':'cộng một','-5':'âm năm','@a':'a',x:'=1+1',y:'007',"'007":'z'};
  const csv=dictionaryToCsv(d);
  for(const cell of ["'1/2","'007","'2.0","'1-2","'1e5","'12:30","'=SUM(A1)","'+1","'-5","'@a","''007"])expect(csv).toContain(cell+',');
  expect(csv).toContain("\r\nx,'=1+1\r\n");
  expect(csv).toContain("\r\ny,'007\r\n");
  expect(csv).not.toMatch(/(^|,|\n)[=+\-@]/);
  expect(parseDictionaryCsv(csv).entries).toEqual(d);
 });
 it('leaves safe cells unprotected and reads old files without apostrophes unchanged',()=>{
  const d={'2024':'hai không hai bốn','0':'không','TP.HCM':'Thành phố Hồ Chí Minh',"'em":'ấy','5G':'năm gờ','hello-world':'x'};
  const csv=dictionaryToCsv(d);
  expect(csv).toBe('﻿Từ gốc,Cách đọc\r\n0,không\r\n2024,hai không hai bốn\r\nTP.HCM,Thành phố Hồ Chí Minh\r\n\'em,ấy\r\n5G,năm gờ\r\nhello-world,x\r\n');
  expect(parseDictionaryCsv(csv).entries).toEqual(d);
  expect(parseDictionaryCsv("'em,ấy\n'x,y\n007,a\n1/2,b\n=1+1,c").entries).toEqual({"'em":'ấy',"'x":'y','007':'a','1/2':'b','=1+1':'c'});
  expect(parseDictionaryCsv("'1/2;một phần hai").entries).toEqual({'1/2':'một phần hai'});const big={'12345678901':'mười một số','123456789012':'mười hai số'};expect(dictionaryToCsv(big)).toContain("\r\n12345678901,mười một số\r\n'123456789012,mười hai số\r\n");expect(parseDictionaryCsv(dictionaryToCsv(big)).entries).toEqual(big);
 });
});
