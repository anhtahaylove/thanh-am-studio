import {test,expect} from '@playwright/test';
test('the theme follows the system live until a fixed choice is made, and the choice persists',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});await page.goto('/');
 const system=page.getByRole('button',{name:'Chuyển giao diện theo hệ thống'}),light=page.getByRole('button',{name:'Chuyển giao diện sáng'}),dark=page.getByRole('button',{name:'Chuyển giao diện tối'});
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(system).toHaveAttribute('aria-pressed','true');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await light.click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(light).toHaveAttribute('aria-pressed','true');await expect(system).toHaveAttribute('aria-pressed','false');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(light).toHaveAttribute('aria-pressed','true');
 await page.emulateMedia({colorScheme:'light'});await dark.click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.emulateMedia({colorScheme:'dark'});await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(dark).toHaveAttribute('aria-pressed','true');
 await system.click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.reload();await expect(system).toHaveAttribute('aria-pressed','true');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});
for(const [stored,os,name] of [['dark','light','tối'],['light','dark','sáng']] as const)test(`a stored ${stored} choice from before the system option keeps working against a ${os} system`,async({page})=>{
 await page.emulateMedia({colorScheme:os});await page.addInitScript(v=>localStorage.setItem('thanh-am-theme',v),stored);await page.goto('/');
 await expect(page.locator('html')).toHaveAttribute('data-theme',stored);await expect(page.getByRole('button',{name:`Chuyển giao diện ${name}`})).toHaveAttribute('aria-pressed','true');
});
test('the three theme buttons stay inside the narrow rail and work there',async({page})=>{
 await page.setViewportSize({width:640,height:800});await page.goto('/');
 const names=['Chuyển giao diện theo hệ thống','Chuyển giao diện sáng','Chuyển giao diện tối'],rail=await page.locator('.sidebar').boundingBox();
 for(const name of names){const b=await page.getByRole('button',{name}).boundingBox();expect(b).not.toBeNull();expect(b!.x).toBeGreaterThanOrEqual(rail!.x);expect(b!.x+b!.width).toBeLessThanOrEqual(rail!.x+rail!.width);expect(b!.y+b!.height).toBeLessThanOrEqual(800);}
 await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
