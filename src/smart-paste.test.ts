import {describe,it,expect} from 'vitest';
import {castLines,scriptChunks} from './domain';

describe('smart paste: "Tên - lời" labels are opt-in',()=>{
 it('leaves the default split as it was: dash lines are narration',()=>{
  expect(scriptChunks('Mai - Chào\nHùng - Ừ')).toEqual([{speaker:'Người dẫn',text:'Mai - Chào'},{speaker:'Người dẫn',text:'Hùng - Ừ'}]);
  expect(scriptChunks('Mai – Chào\nHùng — Ừ').every(c=>c.speaker==='Người dẫn')).toBe(true);
 });
 it('with dash on, "Tên - lời", "Tên – lời" and "Tên — lời" name their speakers, mixed with colon labels',()=>{
  expect(scriptChunks('Mai - Chào\nHùng - Ừ',{dash:true})).toEqual([{speaker:'Mai',text:'Chào'},{speaker:'Hùng',text:'Ừ'}]);
  expect(scriptChunks('Mai: Chào anh.\nHùng – Chào em.\nAnh Ba — Đi thôi.\nCòn nữa.',{dash:true})).toEqual([{speaker:'Mai',text:'Chào anh.'},{speaker:'Hùng',text:'Chào em.'},{speaker:'Anh Ba',text:'Đi thôi.'},{speaker:'Anh Ba',text:'Còn nữa.'}]);
 });
 it('needs two labelled lines, a capital, at most 4 words and no digits, URL or @ in the name',()=>{
  expect(scriptChunks('Hà Nội - thủ đô',{dash:true})).toEqual([{speaker:'Người dẫn',text:'Hà Nội - thủ đô'}]);
  expect(castLines('Hà Nội - thủ đô')).toBe(false);
  const speakers=(t:string)=>[...new Set(scriptChunks(t,{dash:true}).map(c=>c.speaker))];
  expect(scriptChunks('Mai - Chào\n8 - 10 người\nHùng - Ừ',{dash:true})).toEqual([{speaker:'Mai',text:'Chào'},{speaker:'Mai',text:'8 - 10 người'},{speaker:'Hùng',text:'Ừ'}]);
  expect(speakers('Mai - Chào\nmai - thấp\nHùng - Ừ')).toEqual(['Mai','Hùng']);
  expect(speakers('Mai - Chào\nMột hai ba bốn năm - sáu\nHùng - Ừ')).toEqual(['Mai','Hùng']);
  expect(speakers('Mai - Chào\nMai2 - x\nWWW.A.VN - y\nA@B - z\nHùng - Ừ')).toEqual(['Mai','Hùng']);
  expect(speakers('Mai -Chào\nHùng-Ừ')).toEqual(['Người dẫn']);
 });
 it('keeps colon labels exactly as without dash',()=>{
  for(const t of ['Mai: Chào anh.\nAnh vẫn khỏe chứ?\n[Nam]: Khỏe, cảm ơn.\nLúc 8:30 gặp lại.','Lưu ý: đọc chậm.\nCâu thứ hai.','Người 2: Xin chào\nNgười 8:30 sáng','Lan: [P1] Mở đầu.\nNam: Hai.','Mai - Chào: anh\nHùng: Ừ'])expect(scriptChunks(t,{dash:true})).toEqual(scriptChunks(t));
  expect(scriptChunks('Mai - Chào: anh\nHùng: Ừ',{dash:true}).map(c=>c.speaker)).toEqual(['Mai - Chào','Hùng']);
 });
 it('castLines: two or more lines with a speaker other than the narrator',()=>{
  expect(castLines('Mai: Chào anh.\nHùng – Chào em.')).toBe(true);
  expect(castLines('Mai - Chào\nHùng - Ừ\n')).toBe(true);
  expect(castLines('Mai: Chào anh.')).toBe(false);
  expect(castLines('Một câu.\nHai câu.')).toBe(false);
  expect(castLines('Người dẫn: Một.\nNgười dẫn: Hai.')).toBe(false);
  expect(castLines('Mai: Chào\n\n')).toBe(false);
 });
});
