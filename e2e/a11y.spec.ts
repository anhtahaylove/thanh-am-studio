import {test,expect,type Page} from '@playwright/test';
const pages=['Tạo giọng đọc','Chép lời','Thư viện giọng','Hàng đợi','Dự án','Model & cài đặt'];
// WCAG contrast of one colour token on others, resolved through the page's own CSS.
const contrast=(page:Page,fg:string,bgs:string[])=>page.evaluate(([fg,bgs])=>{const probe=document.createElement('i');document.body.append(probe);
 const lum=(token:string)=>{probe.style.color=`var(${token})`;const [r,g,b]=getComputedStyle(probe).color.match(/\d+/g)!.slice(0,3).map(v=>{const c=Number(v)/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
 const out=Math.min(...bgs.map(bg=>{const [a,b]=[lum(fg),lum(bg)].sort((x,y)=>y-x);return (a+0.05)/(b+0.05);}));probe.remove();return out;},[fg,bgs] as const);
test('the narrow rail names every page, marks the current one and keeps the theme toggle',async({page})=>{
 await page.setViewportSize({width:800,height:700});await page.goto('/');
 const nav=page.getByRole('navigation',{name:'Điều hướng chính'});
 for(const name of pages){const button=nav.getByRole('button',{name,exact:true});await expect(button).toBeVisible();await expect(button).toHaveAttribute('title',name);}
 await expect(nav.getByRole('button',{name:'Tạo giọng đọc'})).toHaveAttribute('aria-current','page');
 await nav.getByRole('button',{name:'Chép lời',exact:true}).click();await expect(nav.getByRole('button',{name:'Chép lời'})).toHaveAttribute('aria-current','page');await expect(nav.locator('[aria-current]')).toHaveCount(1);
 await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});
test('muted text, success text, input borders and the focus ring keep AA contrast in both themes',async({page})=>{
 await page.goto('/');
 for(const theme of ['light','dark']){
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  expect(await contrast(page,'--muted',['--bg','--paper','--surface','--green-soft']),`muted text, ${theme}`).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page,'--ok',['--bg','--paper','--surface','--green-soft']),`success text, ${theme}`).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page,'--input-border',['--bg','--paper','--surface']),`input border, ${theme}`).toBeGreaterThanOrEqual(3);
  expect(await contrast(page,'--green',['--bg','--paper','--surface']),`focus ring, ${theme}`).toBeGreaterThanOrEqual(3);
  if(theme==='light')await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();
 }
});
test('lengths and times use the Vietnamese decimal comma and transcript play buttons say what they do',async({page})=>{
 const take={id:'t1',asset_id:'a1',path:'t1.wav',duration_ms:4100,sample_rate:44100,created_at:new Date().toISOString()};
 const segment={id:'s1',text:'Câu một.',normalized_text:'Câu một.',voice_id:null,speaker:'Người dẫn',gap_ms:300,takes:[take],selected_take_id:'t1',trim_start_ms:0,trim_end_ms:null,fade_in_ms:0,fade_out_ms:0,gain_db:0};
 const project={id:'p1',name:'Dấu phẩy',updated_at:new Date().toISOString(),revision:1,segments:[segment],transcript:[{id:'r1',start_ms:1250,end_ms:3500,text:'Xin chào'},{id:'r2',start_ms:9200,end_ms:10000,text:'Tạm biệt'}],dictionary:{},source_asset_id:null};
 await page.goto('/');await page.evaluate(p=>localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([p])),project);await page.reload();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.locator('.audio-dock')).toContainText('4,1 giây · 44,1 kHz');
 await expect(page.getByRole('combobox',{name:'Take đang sử dụng'}).locator('option',{hasText:'Take 1'})).toHaveText('Take 1 · 4,1 giây');
 await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const play=page.getByRole('button',{name:/^Phát từ /});await expect(play).toHaveCount(2);
 await expect(play.nth(0)).toHaveAccessibleName('Phát từ 00:00:01,250');await expect(play.nth(0)).toHaveText('00:00:01,250');await expect(play.nth(1)).toHaveText('00:00:09,200');
});
