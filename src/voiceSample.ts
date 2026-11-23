import type {Job,Project,ProjectSummary,Take,Voice} from './types';

type Asset={assetId:string;start_ms:number};
/** Every take of the project by asset id, with its 0-based index and its segment's. Built once for all the speakers of a render. */
export type TakeIndex=Map<string,{t:Take;n:number;i:number}>;
export const takeIndex=(project:Project):TakeIndex=>new Map(project.segments.flatMap((s,i)=>s.takes.map((t,n)=>[t.asset_id,{t,n,i}] as const)));
/** What a voice's sample button in "Phân vai" plays: a file path, or assets the caller resolves with `get_asset` in order (the next one when one fails). */
export type VoiceSample=
 |{kind:'take'|'clean';path:string;start_ms:number;title:string}
 |{kind:'reference'|'job';assets:Asset[];title:string}
 |{kind:'blocked';blocked:string};

/** Audio that already exists for a voice, never a new job. `jobs` is in list_jobs order, newest first. A reference voice plays its cleaned sample of
 *  this app version, else its recording. A preset or the engine default (`null`) plays the newest take made with it that is still in this project;
 *  a preset then falls back to takes of other projects (at most 3 to try), the default never does, since it may have changed between releases. */
export function voiceSample(voiceId:string|null,{voices,jobs,project,projects,version,takes=takeIndex(project)}:{voices:Voice[];jobs:Job[];project:Project;projects:ProjectSummary[];version:string;takes?:TakeIndex}):VoiceSample{
 const voice=voices.find(v=>v.id===voiceId);
 if(voice?.kind==='reference'&&voice.reference_asset_id){
  const ref=voice.reference_asset_id,clean=jobs.find(j=>j.kind==='clone_preview'&&j.status==='succeeded'&&j.payload.asset_id===ref&&j.payload.version===version&&j.result?.path);
  return clean?{kind:'clean',path:String(clean.result!.path),start_ms:0,title:'Phát 3 giây mẫu đã làm sạch'}:{kind:'reference',assets:[{assetId:ref,start_ms:0}],title:'Phát 3 giây đầu mẫu giọng đã ghi'};
 }
 const made=jobs.filter(j=>j.kind==='tts'&&j.status==='succeeded'&&(j.payload.voice_id??null)===voiceId&&j.result?.asset_id);
 for(const j of made){const found=j.project_id===project.id&&takes.get(String(j.result!.asset_id));if(found)return {kind:'take',path:found.t.path,start_ms:found.t.speech_start_ms??0,title:`Phát 3 giây từ take ${found.n+1} của đoạn ${found.i+1}`};}
 const elsewhere=voiceId===null?[]:made.flatMap(j=>{const p=j.project_id!==project.id&&projects.find(x=>x.id===j.project_id);return p?[{j,name:p.name}]:[];}).slice(0,3);
 if(elsewhere.length)return {kind:'job',assets:elsewhere.map(({j})=>({assetId:String(j.result!.asset_id),start_ms:Number(j.result!.speech_start_ms??0)})),title:`Phát 3 giây từ một take của dự án ${elsewhere[0].name} (${new Date(elsewhere[0].j.created_at).toLocaleDateString('vi-VN')})`};
 return {kind:'blocked',blocked:voiceId===null?'Chưa có take nào trong dự án này tạo bằng giọng mặc định: tạo giọng một đoạn trước.':'Chưa có take nào tạo bằng giọng này: tạo giọng một đoạn trước.'};
}
