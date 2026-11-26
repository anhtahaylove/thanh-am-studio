import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelCard} from './ModelCards';
import type {ModelInfo} from './types';
// Every shipped model has a measured RAM value, so the "not measured yet" branch of the card is only reachable with a stand-in table.
vi.mock('./models',async importOriginal=>{
 const real=await importOriginal<typeof import('./models')>();
 return {...real,MODEL_RAM_MB:{...real.MODEL_RAM_MB,'whisper-turbo':null,'vieneu-v3':2200}};
});
const info=(id:string,name:string):ModelInfo=>({id,name,engine:'stt',installed:false,revision:'9f8e7d6c5b4a3921',license:'MIT',description:'Mô tả ngắn của model.'});
const ram=(id:string)=>{
 const html=renderToStaticMarkup(<ModelCard m={info(id,id)} totalMb={7910}><button>Tải</button></ModelCard>);
 return html.match(/<dt>RAM khi chạy<\/dt><dd>(.*?)(?:<small|<\/dd>)/)![1];
};
describe('model card RAM line',()=>{
 it('says "Chưa đo" for a model whose RAM value is null',()=>{
  expect(ram('whisper-turbo')).toBe('Chưa đo');
 });
 it('keeps the measured figure and the separation pack note on the other cards',()=>{
  expect(ram('vieneu-v3')).toBe('khoảng 2,1 GB');
  expect(ram('separation-runtime')).toBe('Đã tính trong thẻ Tách giọng và nhạc nền');
 });
});
