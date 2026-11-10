import {mediaUrl} from './bridge';
import {validateRecipe} from './domain';
import type {Recipe} from './domain';
let context:AudioContext|undefined;let source:AudioBufferSourceNode|undefined;
export function stopPreview(){source?.stop();source=undefined;}
export async function preview(path:string,recipe:Recipe,onEnded:()=>void):Promise<number[]>{
 stopPreview();validateRecipe(recipe);context??=new AudioContext({sampleRate:48000});await context.resume();
 const response=await fetch(mediaUrl(path));if(!response.ok)throw Error('Đọc audio không thành công');const buffer=await context.decodeAudioData(await response.arrayBuffer());
 const start=recipe.trim_start_ms/1000,end=(recipe.trim_end_ms??recipe.duration_ms)/1000,duration=end-start;
 const gain=context.createGain();const value=10**(recipe.gain_db/20),now=context.currentTime;
 gain.gain.setValueAtTime(recipe.fade_in_ms?0:value,now);if(recipe.fade_in_ms)gain.gain.linearRampToValueAtTime(value,now+recipe.fade_in_ms/1000);
 if(recipe.fade_out_ms){gain.gain.setValueAtTime(value,now+duration-recipe.fade_out_ms/1000);gain.gain.linearRampToValueAtTime(0,now+duration);}
 gain.connect(context.destination);source=context.createBufferSource();source.buffer=buffer;source.connect(gain);source.onended=()=>{gain.disconnect();onEnded();};source.start(now,start,duration);
 const data=buffer.getChannelData(0);const peaks:number[]=[];const stride=Math.max(1,Math.floor(data.length/100));for(let i=0;i<100;i++){let max=0;for(let j=i*stride;j<Math.min((i+1)*stride,data.length);j+=Math.max(1,Math.floor(stride/100)))max=Math.max(max,Math.abs(data[j]));peaks.push(max);}return peaks;
}
