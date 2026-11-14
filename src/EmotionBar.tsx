import {Laugh,Wind,Megaphone} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';

// Tag spellings the pinned VieNeu phonemizer maps to its emotion tokens; the model card calls them experimental.
export const EMOTION_CUES:{tag:string;label:string;icon:LucideIcon}[]=[{tag:'[cười]',label:'Cười',icon:Laugh},{tag:'[thở dài]',label:'Thở dài',icon:Wind},{tag:'[hắng giọng]',label:'Hắng giọng',icon:Megaphone}];

export function EmotionBar({disabled,onInsert}:{disabled?:boolean;onInsert:(tag:string)=>void}){
 return <div className="emotion-bar" role="group" aria-label="Âm thanh biểu cảm (thử nghiệm)">{EMOTION_CUES.map(({tag,label,icon:Icon})=><button key={tag} type="button" className="outlined" disabled={disabled} title={`Chèn ${tag} tại con trỏ (thử nghiệm)`} onClick={()=>onInsert(tag)}><Icon size={14}/>{label}</button>)}</div>;
}
