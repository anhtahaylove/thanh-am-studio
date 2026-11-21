import {makeSegment,normalizeText,uid} from './domain';
import type {Project} from './types';
/** The demo project's name: openDemo finds an earlier copy by it. */
export const DEMO_NAME='Làng chài · dự án mẫu';
// Original text written for this repository (Apache-2.0). Nothing here is quoted from a published work, and the speakers are roles, not people.
// No audio is bundled: takes come only from the user's own VieNeu run.
const LINES:[speaker:string,text:string,chapter?:string][]=[
 ['Người dẫn','Bốn giờ sáng, bến cá còn chìm trong sương mỏng. Những chiếc thuyền thúng lần lượt rẽ sóng, mang về mẻ cá đầu tiên của ngày.','Chương 1: Buổi sáng ở bến'],
 ['Cô Hai','Hôm nay biển hiền, cá cơm về nhiều lắm. Bà con trong HTX ai cũng mừng.'],
 ['Chú Tư','Mừng thì mừng, nhưng đừng quên phần của nhà kho lạnh. [nghỉ 0.5s] Nước đá phải đủ trước trưa.'],
 ['Người dẫn','Tiếng cân rộn rã, tiếng cười lẫn trong mùi muối biển.'],
 ['Người dẫn','Khi mặt trời lên khỏi mặt nước, chợ cá bắt đầu đông người.','Chương 2: Chợ sớm'],
 ['Cô Hai','Cá tươi đây, mua mười ký tặng một bó rau thơm!'],
 ['Chú Tư','Cho tôi hai ký, nhớ chọn con nào mắt còn trong nhé.'],
 ['Người dẫn','Chợ tan, bến lại yên. Làng chài chờ buổi chiều và con nước mới.'],
];
// A transcript to try the transcript page on: two speakers, one line spoken over by the other speaker, and one line the recogniser
// repeated (the page flags it as suspicious).
const ROWS:[start:number,end:number,speaker:number,text:string,overlap?:number][]=[
 [0,3200,0,'Bốn giờ sáng rồi, dậy ra bến thôi.'],
 [3200,6400,1,'Chờ chút, tôi mang theo thùng đá.'],
 [6400,9800,0,'Hôm nay biển hiền, cá cơm về nhiều lắm.',1],
 [9800,12600,1,'Bà con trong HTX ai cũng mừng.'],
 [12600,15200,0,'Nước đá phải đủ trước trưa nhé.'],
 [15200,17800,0,'Nước đá phải đủ trước trưa nhé.'],
 [17800,20900,1,'Được rồi, để tôi đi xem kho lạnh.'],
 [20900,24000,0,'Chợ tan, bến lại yên.'],
];
/** The content of the demo project; ids are new on every call. */
export function demoProject():Pick<Project,'segments'|'transcript'|'dictionary'>{
 const dictionary={HTX:'hợp tác xã'};
 return {
  dictionary,
  segments:LINES.map(([speaker,text,chapter])=>({...makeSegment(text),speaker,normalized_text:normalizeText(text,dictionary),...(chapter?{chapter}:{})})),
  transcript:ROWS.map(([start_ms,end_ms,speaker,text,overlap])=>({id:uid(),start_ms,end_ms,text,speaker,...(overlap===undefined?{}:{overlap_speaker:overlap})})),
 };
}
