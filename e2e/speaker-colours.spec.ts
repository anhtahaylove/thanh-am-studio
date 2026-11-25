import {test,expect,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
// Speaker colours are kept in the project (`speaker_slots`): typing a name, adding "Người N", reopening and the first edit of a project saved
// before 1.0.23 recolour nobody. Tauri is mocked; save_project stores the project, so load_project returns what was saved.
const FIXTURE=JSON.parse(readFileSync('e2e/fixtures/script-12.json','utf8'));
const mock=(o:{project:string})=>{
 const w=window as any;w.isTauri=true;w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));let stored=JSON.parse(o.project);w.__saved=[];
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{switch(cmd){
   case 'list_projects':return [{id:stored.id,name:stored.name,updated_at:stored.updated_at,revision:stored.revision}];case 'load_project':return ipc(stored);
   case 'list_voices':case 'list_jobs':return [];case 'list_models':return [{id:'vieneu-v3',name:'VieNeu v3 Turbo',engine:'tts',installed:true,revision:'r',license:'Apache-2.0',description:''}];
   case 'get_settings':return {dictionary:{}};case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':stored={...ipc(args.project),revision:args.project.revision+1};w.__saved.push(ipc(stored));return ipc(stored);
   default:return null;}}};
};
const open=async(page:Page,project:unknown=FIXTURE)=>{
 await page.addInitScript(mock,{project:JSON.stringify(project)});await page.goto('/');await reopen(page);
};
const reopen=async(page:Page)=>{
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).click();
 await expect(page.locator('article.segment').first()).toBeVisible();
};
// [speaker name, colour slot] per segment, read from the row's inline `--spk: var(--spk-N)`.
const slots=(page:Page)=>page.locator('article.segment').evaluateAll(rows=>rows.map(r=>[r.querySelector<HTMLInputElement>('.speaker-input')!.value,Number(/^var\(--spk-(\d)\)$/.exec((r as HTMLElement).style.getPropertyValue('--spk').trim())?.[1])] as [string,number]));
const saved=(page:Page)=>page.evaluate(()=>(window as any).__saved.at(-1));
const save=async(page:Page)=>{const n=await page.evaluate(()=>(window as any).__saved.length);await page.keyboard.press('Control+s');await expect.poll(()=>page.evaluate(()=>(window as any).__saved.length)).toBeGreaterThan(n);};
const three=(names:string[],extra:object={})=>({...FIXTURE,...extra,segments:names.map((speaker,i)=>({...FIXTURE.segments[i],speaker}))});

test('typing a speaker name in segment 3 keeps every other segment on its colour at every keystroke',async({page})=>{
 await open(page);const before=await slots(page);
 expect(before.slice(0,4)).toEqual([['Người dẫn',0],['Bà Tư',1],['Cậu Hai',2],['Cô giáo',3]]);
 const input=page.getByRole('textbox',{name:'Nhân vật đoạn 3',exact:true});await input.selectText();
 let typed='';
 for(const ch of 'Người 2'){
  await input.pressSequentially(ch);typed+=ch;await expect(input).toHaveValue(typed);
  const now=await slots(page);
  expect(now.filter((_,i)=>i!==2),`after typing "${typed}"`).toEqual(before.filter((_,i)=>i!==2));
  expect(now[2][1],`segment 3 keeps one slot while "${typed}" is typed`).toBe(4);
 }
});
test('"Người 2" added before "Bà Tư" leaves Bà Tư on its colour, the slots are saved, and reopening shows the same colours',async({page})=>{
 await open(page);const before=await slots(page);
 await page.getByRole('textbox',{name:'Nhân vật đoạn 1',exact:true}).fill('Người 2');
 const edited=await slots(page);
 expect(edited[1],'Bà Tư').toEqual(before[1]);expect(edited.slice(1),'every other segment').toEqual(before.slice(1));
 await save(page);
 expect((await saved(page)).speaker_slots).toEqual({'Người 2':4,'Người dẫn':0,'Bà Tư':1,'Cậu Hai':2,'Cô giáo':3});
 await reopen(page);
 expect(await slots(page),'after reopening').toEqual(edited);
});
test('the first edit of a project without speaker_slots (Alt+Up on Hùng, twice) recolours nobody and saves the mapping it showed',async({page})=>{
 await open(page,three(['Lan','Minh','Hùng']));
 expect(await slots(page)).toEqual([['Lan',0],['Minh',1],['Hùng',2]]);
 await page.getByRole('textbox',{name:'Nội dung đoạn 3',exact:true}).focus();await page.keyboard.press('Alt+ArrowUp');
 await expect(page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true})).toHaveValue('Hùng');
 expect(await slots(page),'after the first move').toEqual([['Lan',0],['Hùng',2],['Minh',1]]);
 await page.keyboard.press('Alt+ArrowUp');await expect(page.getByRole('textbox',{name:'Nhân vật đoạn 1',exact:true})).toHaveValue('Hùng');
 expect(await slots(page),'at the top').toEqual([['Hùng',2],['Lan',0],['Minh',1]]);
 await save(page);
 expect((await saved(page)).speaker_slots).toEqual({Lan:0,Minh:1,'Hùng':2});
});
test('a stored speaker_slots with an invalid entry keeps the valid ones and gives the other speaker a valid colour, without an error',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await open(page,three(['Minh','Lan'],{speaker_slots:{Lan:9,Minh:3}}));
 expect(await slots(page)).toEqual([['Minh',3],['Lan',0]]);
 expect(errors).toEqual([]);
});
test('undo and redo of a rename give back the stored colours of the snapshot, not the order-of-appearance guess',async({page})=>{
 await open(page,three(['Minh','Lan'],{speaker_slots:{Minh:3,Lan:5}}));
 expect(await slots(page)).toEqual([['Minh',3],['Lan',5]]);
 const name=page.getByRole('textbox',{name:'Nhân vật đoạn 2',exact:true});await name.fill('Hùng');
 expect(await slots(page),'a rename inherits the slot').toEqual([['Minh',3],['Hùng',5]]);
 await page.getByRole('heading',{level:1}).click(); // Ctrl+Z in a name field is the browser's own text undo
 await page.keyboard.press('Control+z');await expect(name).toHaveValue('Lan');
 expect(await slots(page),'after undo').toEqual([['Minh',3],['Lan',5]]);
 await page.keyboard.press('Control+y');await expect(name).toHaveValue('Hùng');
 expect(await slots(page),'after redo').toEqual([['Minh',3],['Hùng',5]]);
});
test('opening a project without speaker_slots does not mark it unsaved or save it',async({page})=>{
 await open(page);
 await page.waitForTimeout(1500); // longer than the 900 ms autosave delay
 expect(await page.evaluate(()=>(window as any).__saved.length)).toBe(0);
 await expect(page.locator('header').getByText('Đã lưu',{exact:true})).toBeVisible();
});
