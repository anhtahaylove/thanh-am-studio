export type Theme='system'|'light'|'dark';
// What localStorage['thanh-am-theme'] holds: only 'light' and 'dark' count; a missing or unknown value follows the system.
export const parseTheme=(stored:string|null):Theme=>stored==='light'||stored==='dark'?stored:'system';
export function applyTheme(root:{dataset:DOMStringMap},theme:Theme,systemDark:boolean){
 root.dataset.theme=theme==='dark'||theme==='system'&&systemDark?'dark':'light';
}
