import {mediaUrl} from './bridge';
import {validateRecipe} from './domain';
import type {Recipe} from './domain';
let context:AudioContext|undefined;let source:AudioBufferSourceNode|undefined;
// Every stop and every new preview bumps `generation`: a source or a load that belongs to an older one must not touch the dock or start sound.
let generation=0;
export function stopPreview(){generation++;source?.stop();source=undefined;}
/** Plays a take with its recipe, from `fromMs` after the recipe's start. Resolves with the waveform peaks, or null when a newer preview or a stop overtook this one while it loaded (nothing was started). */
export async function preview(path:string,recipe:Recipe,onEnded:()=>void,fromMs=0):Promise<number[]|null>{
 stopPreview();const gen=generation;validateRecipe(recipe);context??=new AudioContext({sampleRate:48000});await context.resume();if(gen!==generation)return null;
 const response=await fetch(mediaUrl(path));if(gen!==generation)return null;if(!response.ok)throw Error('Đọc audio không thành công');const bytes=await response.arrayBuffer();if(gen!==generation)return null;const buffer=await context.decodeAudioData(bytes);if(gen!==generation)return null;
 const start=recipe.trim_start_ms/1000+fromMs/1000,end=(recipe.trim_end_ms??recipe.duration_ms)/1000,duration=Math.max(0,end-start);
 const gain=context.createGain();const value=10**(recipe.gain_db/20),now=context.currentTime;
 gain.gain.setValueAtTime(recipe.fade_in_ms&&!fromMs?0:value,now);if(recipe.fade_in_ms&&!fromMs)gain.gain.linearRampToValueAtTime(value,now+recipe.fade_in_ms/1000);
 if(recipe.fade_out_ms){gain.gain.setValueAtTime(value,now+duration-recipe.fade_out_ms/1000);gain.gain.linearRampToValueAtTime(0,now+duration);}
 gain.connect(context.destination);source=context.createBufferSource();source.buffer=buffer;source.connect(gain);source.onended=()=>{gain.disconnect();if(gen===generation)onEnded();};source.start(now,start,duration);
 const data=buffer.getChannelData(0);const peaks:number[]=[];const stride=Math.max(1,Math.floor(data.length/100));for(let i=0;i<100;i++){let max=0;for(let j=i*stride;j<Math.min((i+1)*stride,data.length);j+=Math.max(1,Math.floor(stride/100)))max=Math.max(max,Math.abs(data[j]));peaks.push(max);}return peaks;
}
