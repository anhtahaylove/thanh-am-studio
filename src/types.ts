export interface Take {id:string;asset_id:string;path:string;duration_ms:number;sample_rate:number;created_at:string}
export interface Segment {id:string;text:string;normalized_text:string;voice_id:string|null;speaker:string;gap_ms:number;takes:Take[];selected_take_id:string|null;trim_start_ms:number;trim_end_ms:number|null;fade_in_ms:number;fade_out_ms:number;gain_db:number}
export interface TranscriptSegment {id:string;start_ms:number;end_ms:number;text:string}
export interface ProjectSummary {id:string;name:string;updated_at:string;revision:number}
export interface Project extends ProjectSummary {segments:Segment[];transcript:TranscriptSegment[];dictionary:Record<string,string>;source_asset_id:string|null}
export interface Asset {id:string;path:string;name:string;duration_ms:number|null;sample_rate:number|null}
export interface Voice {id:string;name:string;kind:'preset'|'reference';reference_asset_id:string|null;consent:boolean;engine_voice_id:string|null}
export interface Job {id:string;kind:string;project_id:string|null;payload:Record<string,unknown>;status:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted';progress:number;error:string|null;result:Record<string,unknown>|null;created_at:string;updated_at:string}
export interface RuntimeStatus {python_ready:boolean;ffmpeg_ready:boolean;worker_ready:boolean;python_path:string|null;ffmpeg_path:string|null;message:string}
export interface ModelInfo {id:string;name:string;engine:string;installed:boolean;revision:string;license:string;description:string}
