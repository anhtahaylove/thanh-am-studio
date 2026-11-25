export type Theme='system'|'light'|'dark'|'contrast';
// What localStorage['thanh-am-theme'] holds: only the four known values count; a missing or unknown one follows the system.
export const parseTheme=(stored:string|null):Theme=>stored==='light'||stored==='dark'||stored==='contrast'?stored:'system';
// The contrast theme is the dark one plus data-contrast="more" on the root; every other theme has no data-contrast.
export function applyTheme(root:{dataset:DOMStringMap},theme:Theme,systemDark:boolean){
 root.dataset.theme=theme==='dark'||theme==='contrast'||theme==='system'&&systemDark?'dark':'light';
 if(theme==='contrast')root.dataset.contrast='more';else delete root.dataset.contrast;
}
