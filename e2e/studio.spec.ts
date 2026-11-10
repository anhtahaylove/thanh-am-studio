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
