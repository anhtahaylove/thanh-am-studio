import {describe,it,expect} from 'vitest';
import {parseCsv,parseDictionaryCsv,dictionaryToCsv,mergeDictionary,importSummary,UTF8_HINT} from './csv';
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
});
