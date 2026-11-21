import {useCallback,useEffect,useRef,useState} from 'react';
import {Download,RefreshCw,Sparkles,X} from 'lucide-react';
import {listen} from '@tauri-apps/api/event';
import {call,desktop} from './bridge';
import {CHANGELOG,changesSince,compareVersions} from './changelog';
import type {ChangelogEntry} from './changelog';

interface UpdateState {phase:'idle'|'checking'|'downloading'|'ready'|'failed';version?:string;notes?:string|null;progress?:number;title?:string;error?:string}
const AUTO_KEY='thanh-am-auto-update',SEEN_KEY='thanh-am-seen-version',CHECK_EVERY_MS=12*3600e3;
const pref=(key:string)=>{try{return localStorage.getItem(key);}catch{return null;}};
const setPref=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* the preference just does not persist */}};
// Plugin errors are English; the common ones get a plain message (an offline check also ends in "Could not fetch a valid release JSON").
const message=(e:unknown)=>{const text=String(e instanceof Error?e.message:e);return /error sending request|connect|dns|timed? ?out|valid release JSON|status: 404/i.test(text)?'Không lấy được thông tin bản mới từ GitHub. Kiểm tra mạng rồi thử lại.':/signature|signed for/i.test(text)?'Bản tải về không khớp chữ ký nên đã bị bỏ, không cài.':text;};

/** Update feed state: an automatic check shortly after start and every 12 h (unless turned off), a background download of a
 * newer release, and the changes since the version the user last saw. */
export function useUpdates(current:string){
 const [state,setState]=useState<UpdateState>({phase:'idle'}),[auto,setAutoState]=useState(()=>pref(AUTO_KEY)!=='0'),stateRef=useRef(state);stateRef.current=state;
 const [whatsNew,setWhatsNew]=useState<ChangelogEntry[]|null>(null);
 /** The newer version found (downloaded and verified), or null when this is the newest; a manual check reports failures. */
 const check=useCallback(async(manual=false)=>{
  const now=stateRef.current;if(now.phase==='checking'||now.phase==='downloading'||now.phase==='ready')return now.version??null;
  setState({phase:'checking'});
  try{const found=await call<{version:string;notes:string|null}|null>('update_check');
   if(!found){setState({phase:'idle'});return null;}
   setState({phase:'downloading',version:found.version,notes:found.notes,progress:0});
   await call('update_download');setState({phase:'ready',version:found.version,notes:found.notes});return found.version;
  }catch(e){setState(manual?{phase:'failed',title:'Không kiểm tra được bản mới',error:message(e)}:{phase:'idle'});if(manual)throw e;return null;}
 },[]);
 useEffect(()=>{if(!desktop)return;let off:(()=>void)|undefined,gone=false;void listen<{downloaded:number;total:number|null}>('update-progress',e=>setState(s=>s.phase==='downloading'&&e.payload.total?{...s,progress:e.payload.downloaded/e.payload.total}:s)).then(u=>{if(gone)u();else off=u;});return()=>{gone=true;off?.();};},[]);
 useEffect(()=>{if(!auto)return;const first=setTimeout(()=>void check(),3000),again=setInterval(()=>void check(),CHECK_EVERY_MS);return()=>{clearTimeout(first);clearInterval(again);};},[auto,check]);
 // The installer runs after the app exits, so a failed install only shows on the next start, as a version older than the one it installed.
 useEffect(()=>{void call<string|null>('update_last_install').then(target=>{if(target&&compareVersions(current,target)<0)setState({phase:'failed',title:`Chưa cài được bản ${target}`,error:'Trình cài đặt bị dừng hoặc gặp lỗi; app vẫn ở bản cũ và sẽ tải lại bản mới ở lần kiểm tra sau. Có thể tải bộ cài từ trang phát hành trên GitHub.'});}).catch(()=>{});},[current]);
 // 1.0.10 and older did not store the seen version; their theme key marks an earlier install, so this one's changes still show.
 useEffect(()=>{const seen=pref(SEEN_KEY)??(pref('thanh-am-theme')?CHANGELOG.find(e=>compareVersions(e.version,current)<0)?.version??null:null);if(seen&&compareVersions(current,seen)>0){const list=changesSince(seen,current);if(list.length)setWhatsNew(list);}if(!seen||compareVersions(current,seen)>0)setPref(SEEN_KEY,current);},[current]);
 const setAuto=(on:boolean)=>{setAutoState(on);setPref(AUTO_KEY,on?'1':'0');};
 // A failed install (say the kept installer was quarantined) leaves the ready state, so the next check downloads it again.
 const install=(restart:boolean)=>call('update_install',{restart}).catch(e=>setState({phase:'failed',title:'Không chạy được trình cài đặt',error:message(e)}));
 return {state,auto,setAuto,check,install,whatsNew,setWhatsNew,dismiss:()=>setState({phase:'idle'})};
}

/** The release notes of a downloaded update that is newer than the bundled changelog, as one entry. */
export const feedEntry=(s:UpdateState):ChangelogEntry=>({version:s.version??'',date:'',changes:(s.notes??'').split('\n').map(l=>l.replace(/^[-•*]\s*/,'').trim()).filter(Boolean)});

export function UpdateBanner({state,onInstall,onShowChanges,onDismiss}:{state:UpdateState;onInstall:()=>void;onShowChanges:()=>void;onDismiss:()=>void}){
 if(state.phase==='downloading')return <div className="alert update" role="status"><Download size={18}/><span>Đang tải bản {state.version}{state.progress?` · ${Math.round(state.progress*100)} %`:'…'}</span></div>;
 if(state.phase==='ready')return <div className="alert update" role="status"><Sparkles size={18}/><span>Bản {state.version} đã tải xong và đã kiểm chữ ký. App sẽ cài khi bạn đóng cửa sổ.</span><button className="quiet" onClick={onShowChanges}>Có gì mới</button><button className="primary" onClick={onInstall}>Cài ngay và mở lại</button></div>;
 if(state.phase==='failed')return <div className="alert error" role="alert"><div><strong>{state.title}</strong><p>{state.error}</p></div><button type="button" className="icon-button" aria-label="Đóng lỗi cập nhật" title="Đóng lỗi cập nhật" onClick={onDismiss}><X size={17}/></button></div>;
 return null;
}

// Escape closes a dialog wherever focus is, also after a click on its text moved focus to the page; `active` is false while it is
// closed or covered. The listener stays put across renders: one re-added while an Escape is being dispatched would miss that key.
export function useEscape(close:()=>void,active=true){const latest=useRef(close);latest.current=close;useEffect(()=>{if(!active)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.isComposing)latest.current();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[active]);}

export function WhatsNew({entries,onClose}:{entries:ChangelogEntry[];onClose:()=>void}){
 useEscape(onClose);
 return <div className="modal-backdrop"><section className="modal panel whats-new" role="dialog" aria-modal="true" aria-labelledby="whats-new-title"><div className="panel-toolbar"><h3 id="whats-new-title"><Sparkles size={17}/>Có gì mới</h3><button type="button" className="icon-button" aria-label="Đóng Có gì mới" title="Đóng Có gì mới" autoFocus onClick={onClose}><X size={17}/></button></div>
  {entries.map(e=><article key={e.version}><h4>Bản {e.version}{e.date&&<span>{e.date.split('-').reverse().join('/')}</span>}</h4><ul>{e.changes.map(c=><li key={c}>{c}</li>)}</ul></article>)}
  <button className="primary" onClick={onClose}>Đã hiểu</button></section></div>;
}

export function InstallOnClose({version,onInstall,onLater,onCancel}:{version:string;onInstall:()=>void;onLater:()=>void;onCancel:()=>void}){
 useEscape(onCancel);
 return <div className="modal-backdrop"><section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="install-close-title"><div className="panel-toolbar"><h3 id="install-close-title">Cài bản {version} rồi đóng?</h3><button type="button" className="icon-button" aria-label="Quay lại app" title="Quay lại app" autoFocus onClick={onCancel}><X size={17}/></button></div>
  <p>Bản cập nhật đã tải xong và đã kiểm chữ ký. Trình cài đặt chạy vài giây; dự án, take và model được giữ nguyên.</p>
  <div className="modal-actions"><button className="outlined" onClick={onLater}>Đóng, để lần sau</button><button className="primary" onClick={onInstall}>Cài và đóng</button></div></section></div>;
}

export function UpdateSettings({current,auto,state,onAuto,onCheck,onShowChanges}:{current:string;auto:boolean;state:UpdateState;onAuto:(on:boolean)=>void;onCheck:()=>void;onShowChanges:()=>void}){
 const busy=state.phase==='checking'||state.phase==='downloading';
 return <section className="panel update-settings"><div className="inspector-heading"><RefreshCw size={17}/><h3>Cập nhật</h3><span className="badge">Bản {current}</span></div>
  <label className="check"><input type="checkbox" checked={auto} disabled={!desktop} onChange={e=>onAuto(e.target.checked)}/>Tự kiểm tra và tải bản mới</label>
  <p>App chỉ hỏi GitHub xem có bản mới không và tải bộ cài có chữ ký; không gửi nội dung hay tệp của bạn. Bản mới được cài khi bạn đóng cửa sổ.</p>
  <div className="update-actions"><button className="outlined" disabled={busy||state.phase==='ready'} onClick={onCheck}>{busy?<><RefreshCw className="spin" size={15}/>Đang kiểm tra…</>:<><RefreshCw size={15}/>Kiểm tra ngay</>}</button><button className="quiet" onClick={onShowChanges}><Sparkles size={15}/>Có gì mới</button></div></section>;
}
