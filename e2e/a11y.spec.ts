import {test,expect,type Locator,type Page} from '@playwright/test';
const pages=['Tạo giọng đọc','Chép lời','Thư viện giọng','Hàng đợi','Dự án','Model & cài đặt'];
// WCAG contrast of two computed colours; a missing token resolves to the inherited colour, so callers first check that it is defined.
const ratio=(a:string,b:string)=>{const lum=(c:string)=>{const [r,g,b]=c.match(/[\d.]+/g)!.slice(0,3).map(v=>{const x=Number(v)/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const tokens=(page:Page,names:string[])=>page.evaluate(names=>{const probe=document.createElement('i');document.body.append(probe);const root=getComputedStyle(document.documentElement);
 const out=Object.fromEntries(names.map(n=>{probe.style.color=`var(${n})`;return [n,root.getPropertyValue(n).trim()?getComputedStyle(probe).color:''];}));probe.remove();return out;},names);
// The colours an element draws its outline and border with, and what is behind it: the first ancestor with a visible background.
const colours=(target:Locator)=>target.evaluate(el=>{let p=el.parentElement;while(p&&/^rgba\(.*,\s*0\)$|^transparent$/.test(getComputedStyle(p).backgroundColor))p=p.parentElement;const s=getComputedStyle(el);
 return {outline:`${s.outlineStyle} ${s.outlineWidth}`,outlineColor:s.outlineColor,border:s.borderTopColor,background:s.backgroundColor,behind:getComputedStyle(p??document.documentElement).backgroundColor};});
test('the narrow rail names every page, marks the current one and keeps the theme toggle',async({page})=>{
 await page.setViewportSize({width:800,height:700});await page.goto('/');
 const nav=page.getByRole('navigation',{name:'Điều hướng chính'});
 for(const name of pages){const button=nav.getByRole('button',{name,exact:true});await expect(button).toBeVisible();await expect(button).toHaveAttribute('title',name);}
 await expect(nav.getByRole('button',{name:'Tạo giọng đọc'})).toHaveAttribute('aria-current','page');
 await nav.getByRole('button',{name:'Chép lời',exact:true}).click();await expect(nav.getByRole('button',{name:'Chép lời'})).toHaveAttribute('aria-current','page');await expect(nav.locator('[aria-current]')).toHaveCount(1);
 await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});
test('muted text, success text, input borders and the focus ring keep AA contrast in both themes',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 const bgs=['--bg','--paper','--surface','--green-soft'],input=page.getByLabel('Nghỉ sau (ms)');
 for(const theme of ['light','dark']){
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const c=await tokens(page,['--muted','--ok',...bgs]);for(const [n,v] of Object.entries(c))expect(v,`${n} is defined, ${theme}`).not.toBe('');
  for(const fg of ['--muted','--ok'])for(const bg of bgs)expect(ratio(c[fg],c[bg]),`${fg} on ${bg}, ${theme}`).toBeGreaterThanOrEqual(4.5);
  const box=await colours(input);expect(Math.min(ratio(box.border,box.background),ratio(box.border,box.behind)),`input border ${box.border} in ${box.background} on ${box.behind}, ${theme}`).toBeGreaterThanOrEqual(3);
  // After a Tab the keyboard is the input mode, so moving focus by script still shows :focus-visible: once in the dark sidebar, once on the page.
  await page.keyboard.press('Tab');
  for(const target of [page.getByRole('button',{name:'Tạo giọng đọc',exact:true}),page.getByRole('button',{name:'Thêm nội dung',exact:true})]){
   await target.focus();const ring=await colours(target);expect(ring.outline,`focus ring style, ${theme}`).toBe('solid 2px');
   expect(ratio(ring.outlineColor,ring.behind),`focus ring ${ring.outlineColor} on ${ring.behind}, ${theme}`).toBeGreaterThanOrEqual(3);
  }
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
