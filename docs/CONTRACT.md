# Desktop/worker contract v1

All JSON fields are snake_case. Times are milliseconds except worker STT segments (seconds). IDs UUID strings. No HTTP server.

## Tauri commands (invoke)
- `list_projects` -> ProjectSummary[]
- `create_project({name})` -> Project
- `load_project({id})` -> Project
- `save_project({project})` -> Project (revision optimistic lock; increments revision)
- `delete_project({id})` -> void (metadata only, no shared asset deletion)
- `get_settings` -> AppSettings (defaults to `{dictionary:{}}`)
- `save_settings({settings})` -> AppSettings (validated: `dictionary` is an object of non-empty string keys to string values, at most 5000 entries, each at most 512 bytes; other fields are dropped)
- `list_jobs` -> Job[]
- `enqueue_job({kind,projectId,payload})` -> Job
- `cancel_job({id})`, `retry_job({id})` -> Job
- `runtime_status` -> RuntimeStatus
- `read_text_file({path})` -> string (TXT/SRT/VTT/CSV only, UTF-8, BOM removed)
- `import_asset({path})` -> Asset (copies to app data by hash, original untouched)
- `get_asset({id})` -> Asset (restore imported source playback)
- `list_models` -> ModelInfo[]
- `download_model({id})` -> Job
- `export_text({path,content})` -> void (TXT/SRT/VTT/CSV only)
- `export_asset({assetId,path})` -> void (explicit native save dialog output)
- `list_voices` -> Voice[]
- `save_voice({voice})` -> Voice (reference asset + consent boolean)

Use @tauri-apps/plugin-dialog for open/save dialogs; convertFileSrc(asset.path) for audio. Browser mode must label itself as preview; no fake inference successes.

## Data
ProjectSummary: {id,name,updated_at,revision}
Project: {id,name,updated_at,revision,segments: Segment[],transcript: TranscriptSegment[],dictionary: Record<string,string>,source_asset_id: string|null}
AppSettings: {dictionary: Record<string,string>} (app-wide pronunciation dictionary; TTS normalization applies `{...appDictionary, ...project.dictionary}`, so the project entry wins)
Segment: {id,text,normalized_text,voice_id:string|null,speaker:string,gap_ms:number,takes: Take[],selected_take_id:string|null,trim_start_ms:number,trim_end_ms:number|null,fade_in_ms:number,fade_out_ms:number,gain_db:number}
Take: {id,asset_id,path,duration_ms,sample_rate,created_at}
TranscriptSegment: {id,start_ms,end_ms,text}
Asset: {id,path,name,duration_ms:number|null,sample_rate:number|null}
Voice: {id,name,kind:'preset'|'reference',reference_asset_id:string|null,consent:boolean,engine_voice_id:string|null}
Job: {id,kind,project_id:string|null,payload:object,status:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted',progress:number,error:string|null,result:object|null,created_at,updated_at}
RuntimeStatus: {python_ready:boolean,ffmpeg_ready:boolean,worker_ready:boolean,python_path:string|null,ffmpeg_path:string|null,message:string}
ModelInfo: {id,name,engine,installed:boolean,revision:string,license:string,description:string}

## Client editing rules
- Undo/redo keeps at most 50 project snapshots taken per edit (typing within 1s collapses into one step) and is cleared when a project is opened, created, reloaded or deleted. Restoring a snapshot keeps the current `revision` and unions takes per segment id from the current project (a segment created after the snapshot that already owns takes is kept), so undo never removes a take the server added.
- Segment split: the first half keeps the id, takes and `selected_take_id`; the second gets a new id and no takes. Merge keeps the first segment's id and takes; the next segment's takes are detached from the project (assets stay on disk) after a confirmation.
- Transcript times are validated before they reach `save_project`: `start_ms >= 0` and `end_ms > start_ms`; invalid edits are rejected in the UI and STT results are clamped to this range.
- `stt` jobs are only enqueued when `list_models` reports the chosen whisper model as installed.
- On desktop window close with unsaved edits the UI flushes `save_project` first (capability `core:window:allow-destroy`); if saving fails the user may choose to close and discard.

## Job kinds and payloads
- tts: {segment_id,text,voice_id:string|null,reference_asset_id:string|null}; backend resolves voice/reference and model paths; result adds a new take without replacing existing selection (first take auto-selected only when none). Takes are append-only: adding one does not change the project revision, and save_project keeps stored takes the client has not seen.
- stt: {asset_id,model_id:'whisper-small'|'whisper-turbo',language:'vi'|'auto'}; result transcript must not silently overwrite edited transcript: retain result on job, UI applies explicitly.
- render: {segments:Segment[],normalize:boolean,format:'wav'|'mp3'}; backend resolves selected takes by asset IDs, ignores untrusted payload paths. Output is a new asset.
- model_download: {model_id}; download pins manifest revision and verifies cached content.

## Worker JSON-lines protocol
One process per job, one JSON request on stdin, UTF-8 JSON events on stdout; diagnostics stderr. Request: {protocol:1,id,operation:'tts'|'stt'|'render'|'download'|'probe'|'health',payload:object,output_dir,models_dir}. Output: {protocol:1,id,event:'progress',progress:0..1,message?} or {protocol:1,id,event:'result',result:object} or {protocol:1,id,event:'error',code,message}. Exit nonzero on failure. Never report a result before atomic output finalization.

Worker tts payload {text,voice_id?,reference_path?,model_path,output_name}; result {path,duration_ms,sample_rate}.
Worker tts batch payload {model_path,items:[{text,voice_id?,reference_path?,output_name}]}: the engine loads once; each item reports {protocol:1,id,event:'item',index,result:{path,duration_ms,sample_rate}} or {...,event:'item',index,error:{code,message}}; a failed item does not stop the batch; final result {count}. The desktop batches up to 32 queued tts jobs per worker process.
Worker stt payload {input_path,model_path,language:'vi'|'auto'}; result {segments:[{start,end,text}],language}.
Worker render payload {clips:[{path,trim_start_ms,trim_end_ms,gap_ms,fade_in_ms,fade_out_ms,gain_db}],normalize,format,ffmpeg_path?}; result {path,duration_ms,sample_rate}.
Worker download payload {model_id}; result {model_id,path,revision}.

Resources: worker directory distributed as Tauri resources; Python/FFmpeg resolved from the bundled resource runtime (runtime/python, runtime/ffmpeg); release builds never use the source checkout, PATH or env vars. Debug builds may fall back to the source tree and THANHAM_PYTHON / THANHAM_FFMPEG. The worker runs as python -I -X utf8 with THANHAM_FFMPEG/THANHAM_FFPROBE set to the bundled binaries. Missing runtime/model yields actionable error, never placeholder audio.
