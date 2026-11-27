import {test,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
// 1.0.26 S2: the sidebar lists four pages. "Dự án" is a top-bar button, the voice library is a section of "Model & cài đặt" (2 clicks), and a separate
// "Thêm giọng…" button beside the inspector voice select opens it. The select and its options are unchanged. Tauri is mocked; __clicks counts trusted clicks.
const mock=()=>{
 const w=window as any;w.isTauri=true;w.__clicks=0;
 addEventListener('click',e=>{if(e.isTrusted&&(e as MouseEvent).detail>0)w.__clicks++;},true);
 const seg=(id:string,text:string)=>({id,text,normalized_text:text,voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[],selected_take_id:null,trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0});
 const project={id:'p1',name:'Dự án một',updated_at:'2026-11-22T00:00:00Z',revision:1,transcript:[],dictionary:{},source_asset_id:null,segments:[seg('s1','Xin chào làng chài.')]};
 const voices=[['v1','Bắc nữ'],['v2','Nam trầm'],['v3','Trung nữ']].map(([id,name])=>({id,name,kind:'preset',reference_asset_id:null,consent:false,engine_voice_id:id}));
 w.__TAURI_INTERNALS__={convertFileSrc:(p:string)=>p,transformCallback:()=>1,unregisterCallback:()=>{},metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
  invoke:async(cmd:string,args:any)=>{const ipc=(v:unknown)=>JSON.parse(JSON.stringify(v));switch(cmd){
   case 'list_projects':return [{id:'p1',name:project.name,updated_at:project.updated_at,revision:1}];case 'load_project':return ipc(project);case 'list_voices':return ipc(voices);
   case 'list_jobs':case 'list_models':return [];case 'get_settings':return {dictionary:{}};
   case 'runtime_status':return {python_ready:true,ffmpeg_ready:true,worker_ready:true,python_path:null,ffmpeg_path:null,message:''};
   case 'save_project':return {...ipc(args.project),revision:args.project.revision+1};
   default:return null;}}};
};
const NAVBAR=(page:Page)=>page.getByRole('navigation',{name:'Điều hướng chính'});
const h1=(page:Page)=>page.getByRole('heading',{level:1});
const clicks=(page:Page)=>page.evaluate(()=>(window as any).__clicks as number);
const open=async(page:Page)=>{await page.addInitScript(mock);await page.goto('/');await expect(NAVBAR(page)).toBeVisible();};
const openProject=async(page:Page)=>{
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án',exact:true}).first().click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1',exact:true})).toBeVisible();
};

test('the sidebar has four items in visual and tab order, and the active page is marked',async({page})=>{
 await open(page);
 const items=NAVBAR(page).getByRole('button');
 await expect(items).toHaveText(['Tạo giọng đọc','Chép lời','Model & cài đặt','Hàng đợi']);
 await expect(items.nth(0)).toHaveAttribute('aria-current','page');
 await items.nth(0).focus();
 for(const n of ['Chép lời','Model & cài đặt','Hàng đợi']){await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:n,exact:true})).toBeFocused();}
 await items.nth(2).click();await expect(h1(page)).toContainText('Model & cài đặt');
 await expect(items.nth(2)).toHaveAttribute('aria-current','page');await expect(items.nth(0)).not.toHaveAttribute('aria-current','page');
});

test('the top-bar Dự án button opens the projects page, which stays reachable from any page',async({page})=>{
 await open(page);
 const projects=page.locator('.topbar').getByRole('button',{name:'Dự án',exact:true});
 await expect(NAVBAR(page).getByRole('button',{name:'Dự án'})).toHaveCount(0);
 await projects.click();await expect(h1(page)).toContainText('Dự án');await expect(page.locator('.project-card')).toHaveCount(1);
 await expect(projects).toHaveAttribute('aria-current','page');
 await expect(NAVBAR(page).locator('[aria-current=page]')).toHaveCount(0); // no sidebar item stands for it
 for(const n of ['Model & cài đặt']){await NAVBAR(page).getByRole('button',{name:n}).click();await expect(h1(page)).toContainText(n);await projects.click();await expect(h1(page)).toContainText('Dự án');}
 await NAVBAR(page).getByRole('button',{name:'Hàng đợi'}).click();await expect(page.getByRole('complementary',{name:'Hàng đợi'})).toBeVisible();await expect(h1(page)).toContainText('Dự án'); // the queue opens as a drawer on the projects page (S3a)
});

test('Thư viện giọng is two clicks away: Model & cài đặt, then its section',async({page})=>{
 await open(page);
 await NAVBAR(page).getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 const section=page.locator('details.mc-voices'),card=section.locator('.voice-card');
 await expect(section.locator('summary')).toHaveText('Thư viện giọng');await expect(section).not.toHaveAttribute('open','');await expect(card.first()).toBeHidden();
 await section.locator('summary').click();
 await expect(card).toHaveCount(3);await expect(card.first()).toBeVisible();
 await expect(page.getByRole('button',{name:'Lưu mẫu giọng',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Chọn mẫu audio',exact:true})).toBeVisible();
 expect(await clicks(page)).toBe(2);
});

test('the Thêm giọng… button beside the voice select opens the voice library and takes focus there',async({page})=>{
 await open(page);await openProject(page);
 const select=page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true}),add=page.getByRole('button',{name:'Thêm giọng…',exact:true});
 await expect(add).toBeVisible();
 expect(await select.evaluate((s,b)=>s.closest('.field-row')===b.closest('.field-row')&&!!s.closest('.field-row'),await add.elementHandle())).toBe(true);
 await add.click();
 await expect(h1(page)).toContainText('Model & cài đặt');
 const section=page.locator('details.mc-voices');await expect(section).toHaveAttribute('open','');await expect(section.locator('summary')).toBeFocused();
 await expect(section.locator('.voice-card')).toHaveCount(3);
});

test('arrowing through every voice option never changes the page or navigates',async({page})=>{
 await open(page);await openProject(page);
 const select=page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true});
 await expect(page.getByRole('button',{name:'Thêm giọng…',exact:true})).toBeVisible(); // the way to the voice library is a button, not an option
 expect(await select.locator('option').allTextContents()).toEqual(['Giọng mặc định của engine','Bắc nữ','Nam trầm','Trung nữ']);
 const url=page.url();await select.focus();
 for(const key of ['ArrowDown','ArrowDown','ArrowDown','ArrowDown','ArrowUp','ArrowUp','ArrowUp','ArrowUp']){
  await page.keyboard.press(key);
  await expect(h1(page)).toContainText('Tạo giọng đọc');await expect(page.locator('details.mc-voices')).toHaveCount(0);expect(page.url()).toBe(url);
 }
 await expect(select).toBeFocused();
});

for(const [width,height] of [[1024,720],[1440,1000]])test(`at ${width}x${height} the voice select keeps its full field width and the add-voice button sits under it`,async({page})=>{
 await page.setViewportSize({width,height});await open(page);await openProject(page);
 const select=page.getByRole('combobox',{name:'Giọng đoạn 1',exact:true}),add=page.getByRole('button',{name:'Thêm giọng…',exact:true});
 await expect(add).toBeVisible();
 const s=await select.boundingBox(),f=await select.locator('xpath=ancestor::fieldset[1]').boundingBox(),b=await add.boundingBox();
 expect(s!.width,'select width against its field').toBeGreaterThanOrEqual(f!.width*0.95);
 expect(b!.y,'the button starts below the select').toBeGreaterThanOrEqual(s!.y+s!.height);
 await select.focus();await page.keyboard.press('Tab');await expect(add,'the button follows the select in tab order').toBeFocused();
});
