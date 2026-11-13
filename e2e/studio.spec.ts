import {readFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';
test('browser preview edits and persists a real project without pretending inference',async({page})=>{
 await page.goto('/');await expect(page.getByText('Bản xem trước UI',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();
 const text=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await text.fill('Xin chào Việt Nam. Đây là câu chuyện của tôi.');
 await expect(page.getByRole('button',{name:'Tạo giọng tất cả'})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Đã lưu'})).toBeVisible();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await expect(page.getByRole('heading',{name:'Dự án đầu tiên'})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Xin chào Việt Nam. Đây là câu chuyện của tôi.');
});
test('script import, dictionary and segment controls remain functional',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Xin chào TP.HCM\nChúng ta kể chuyện.');await page.getByRole('button',{name:'Thêm vào kịch bản'}).click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Chúng ta kể chuyện.');await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByRole('textbox',{name:'Từ gốc',exact:true}).fill('TP.HCM');await page.getByRole('textbox',{name:'Cách đọc',exact:true}).fill('Thành phố Hồ Chí Minh');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 await page.getByText('Văn bản sau chuẩn hóa',{exact:true}).click();await expect(page.getByText('Xin chào Thành phố Hồ Chí Minh',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Đưa đoạn xuống',exact:true}).first().click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Chúng ta kể chuyện.');
});
test('navigation, theme and screen sizes have no overflow',async({page})=>{
 await page.goto('/');for(const name of ['Chép lời','Thư viện giọng','Hàng đợi','Dự án','Model & cài đặt']){await page.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{level:1})).toContainText(name);}
 await page.getByRole('button',{name:'Chuyển giao diện tối'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 for(const width of [1440,1280,960,640]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
});
test('app dictionary persists, applies to every project and loses to the project dictionary',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Model & cài đặt',exact:true}).click();
 await page.getByRole('textbox',{name:'Từ gốc',exact:true}).fill('TP.HCM');await page.getByRole('textbox',{name:'Cách đọc',exact:true}).fill('Thành phố Hồ Chí Minh');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 await expect(page.getByText('TP.HCM → Thành phố Hồ Chí Minh')).toBeVisible();await page.reload();await page.getByRole('button',{name:'Model & cài đặt',exact:true}).click();await expect(page.getByText('TP.HCM → Thành phố Hồ Chí Minh')).toBeVisible();
 await page.getByRole('button',{name:'Tạo giọng đọc',exact:true}).click();await page.getByRole('button',{name:'Viết đoạn đầu tiên'}).click();await page.getByRole('textbox',{name:'Nội dung đoạn 1'}).fill('Xin chào TP.HCM');
 await page.getByText('Văn bản sau chuẩn hóa',{exact:true}).click();await expect(page.getByText('Xin chào Thành phố Hồ Chí Minh',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Từ điển phát âm'}).click();await page.getByRole('textbox',{name:'Từ gốc',exact:true}).fill('TP.HCM');await page.getByRole('textbox',{name:'Cách đọc',exact:true}).fill('Sài Gòn');await page.getByRole('button',{name:'Thêm cách đọc'}).click();
 await expect(page.getByText('Xin chào Sài Gòn',{exact:true})).toBeVisible();
});
test('speaker panel, split, merge and undo/redo edit the script',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một. Câu hai.\nDòng sau.');await page.getByRole('button',{name:'Thêm vào kịch bản'}).click();
 await expect(page.getByRole('combobox',{name:'Giọng của Người dẫn'})).toBeVisible();
 await page.getByRole('button',{name:'Chia đoạn tại con trỏ'}).first().click();
 await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Câu một.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Câu hai.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveValue('Dòng sau.');
 await page.getByRole('button',{name:'Gộp với đoạn sau'}).first().click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 1'})).toHaveValue('Câu một. Câu hai.');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Dòng sau.');
 await page.keyboard.press('Control+z');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toHaveValue('Dòng sau.');
 await page.keyboard.press('Control+Shift+z');await expect(page.getByRole('textbox',{name:'Nội dung đoạn 2'})).toHaveValue('Dòng sau.');
 await page.getByRole('button',{name:'Hoàn tác (Ctrl+Z)'}).click();await expect(page.getByRole('textbox',{name:'Nội dung đoạn 3'})).toBeVisible();await expect(page.getByRole('button',{name:'Làm lại (Ctrl+Shift+Z)'})).toBeEnabled();
});
test('transcript rows can be added and deleted and invalid times are rejected',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.getByRole('button',{name:'Thêm dòng'}).click();await page.getByRole('button',{name:'Thêm dòng'}).click();
 const ends=page.getByLabel('Đến (ms)');await expect(ends).toHaveCount(2);await expect(ends.nth(0)).toHaveValue('1000');await expect(ends.nth(1)).toHaveValue('2000');
 await ends.nth(0).fill('0');await expect(page.getByRole('alert')).toContainText('Mốc thời gian không hợp lệ');await expect(ends.nth(0)).toHaveValue('1000');
 await page.getByRole('button',{name:'Xóa dòng'}).first().click();await expect(ends).toHaveCount(1);
});
test('transcript find and replace changes every match in one undo step',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Chép lời',exact:true}).click();await page.getByRole('button',{name:'Thêm dòng'}).click();await page.getByRole('button',{name:'Thêm dòng'}).click();
 const texts=page.getByLabel(/^Transcript tại/);await texts.nth(0).fill('chợ biến thành');await texts.nth(1).fill('Chợ Biến Thành đông vui');
 await page.keyboard.press('Control+f');await expect(page.getByLabel('Tìm trong transcript')).toBeFocused();await page.keyboard.type('biến thành');
 await page.getByLabel('Thay bằng').fill('Bến Thành');await page.getByRole('button',{name:'Thay tất cả'}).click();
 await expect(page.getByRole('status')).toContainText('Đã thay 2 chỗ');await expect(texts.nth(0)).toHaveValue('chợ Bến Thành');await expect(texts.nth(1)).toHaveValue('Chợ Bến Thành đông vui');
 await page.getByLabel('Tìm trong transcript').fill('');await page.keyboard.press('Control+z');await expect(texts.nth(0)).toHaveValue('chợ biến thành');
});
test('a pause mark is inserted at the cursor',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Thêm nội dung',exact:true}).click();await page.getByRole('textbox',{name:'Nội dung cần thêm'}).fill('Câu một. Câu hai.');await page.getByRole('button',{name:'Thêm vào kịch bản'}).click();
 const box=page.getByRole('textbox',{name:'Nội dung đoạn 1'});await box.click();await page.keyboard.press('Control+Home');for(let i=0;i<8;i++)await page.keyboard.press('ArrowRight');
 await page.getByRole('button',{name:'Chèn khoảng nghỉ 0,5 giây tại con trỏ'}).click();await expect(box).toHaveValue('Câu một. [nghỉ 0.5s] Câu hai.');
});
test('project dictionary imports a semicolon CSV in one undo step and exports it with a BOM',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Từ điển phát âm'}).click();await expect(page.getByRole('button',{name:'Xuất CSV'})).toBeDisabled();
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Nhập CSV'}).click();
 await (await chooser).setFiles({name:'tu-dien.csv',mimeType:'text/csv',buffer:Buffer.from('\uFEFFTừ gốc;Cách đọc\r\nTP.HCM;Thành phố Hồ Chí Minh\r\n"AI; ML";trí tuệ nhân tạo\r\nchỉ một cột\r\n')});
 await expect(page.getByText('Đã nhập CSV: thêm 2, cập nhật 0, bỏ qua 1 dòng không hợp lệ (dòng 4).',{exact:false})).toBeVisible();await expect(page.getByText('TP.HCM → Thành phố Hồ Chí Minh')).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Xuất CSV'}).click();
 expect(readFileSync(await (await download).path(),'utf8')).toBe('\uFEFFTừ gốc,Cách đọc\r\nTP.HCM,Thành phố Hồ Chí Minh\r\n"AI; ML",trí tuệ nhân tạo\r\n');
 await page.keyboard.press('Control+z');await expect(page.getByText('TP.HCM → Thành phố Hồ Chí Minh')).toHaveCount(0);await expect(page.getByText('AI; ML → trí tuệ nhân tạo')).toHaveCount(0);
});
test('speaker panel summarizes diarized rows and merges one speaker into another in one undo step',async({page})=>{
 const row=(i:number,speaker:number,start_ms:number,end_ms:number)=>({id:`r${i}`,start_ms,end_ms,text:`Câu ${i}`,speaker});
 const project={id:'p1',name:'Phỏng vấn',updated_at:new Date().toISOString(),revision:1,segments:[],transcript:[row(1,0,0,4000),row(2,1,4000,6000),row(3,2,6000,9000),row(4,0,9000,10000),row(5,2,10000,11000)],dictionary:{},source_asset_id:null};
 await page.goto('/');await page.evaluate(p=>localStorage.setItem('thanh-am-preview-projects-v1',JSON.stringify([p])),project);await page.reload();
 await page.getByRole('button',{name:'Dự án',exact:true}).click();await page.getByRole('button',{name:'Mở dự án'}).click();await page.getByRole('button',{name:'Chép lời',exact:true}).click();
 const panel=page.getByRole('group',{name:'Người nói'});await expect(panel).toContainText('Người 1');await expect(panel).toContainText('2 đoạn · 5 giây');await expect(panel).toContainText('Người 3');
 await expect(page.getByRole('button',{name:'Nghe mẫu Người 1 (cần audio gốc)'})).toBeDisabled();
 await page.getByRole('combobox',{name:'Gộp Người 3 vào'}).selectOption('Người 1');await page.getByRole('button',{name:'Gộp Người 3 vào Người 1'}).click();
 await expect(page.getByText('Đã gộp 2 đoạn của Người 3 vào Người 1.',{exact:false})).toBeVisible();await expect(page.getByRole('combobox',{name:'Gộp Người 3 vào'})).toHaveCount(0);
 await expect(panel).toContainText('4 đoạn · 9 giây');
 const chips=page.getByRole('combobox',{name:/^Người nói tại/});await expect(chips.nth(2)).toHaveValue('0');await expect(chips.nth(4)).toHaveValue('0');
 await page.keyboard.press('Control+z');await expect(chips.nth(2)).toHaveValue('2');await expect(page.getByRole('combobox',{name:'Gộp Người 3 vào'})).toBeVisible();
});
