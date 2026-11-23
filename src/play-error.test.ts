import {describe,it,expect} from 'vitest';
import {playError} from './bridge';
describe('playError',()=>{
 it('keeps an interrupted play() silent',()=>{
  expect(playError(new DOMException('The play() request was interrupted by a call to pause().','AbortError'))).toBeNull();
 });
 it('names a missing or unsupported file in Vietnamese',()=>{
  expect(playError(new DOMException('Failed to load because no supported source was found.','NotSupportedError'))).toBe('Không phát được audio này: tệp không còn hoặc định dạng không được hỗ trợ.');
 });
 it('asks for another press when playback is not allowed yet',()=>{
  expect(playError(new DOMException('play() failed because the user didn\'t interact with the document first.','NotAllowedError'))).toBe('Ứng dụng chưa được phép phát âm thanh. Bấm phát lại một lần nữa.');
 });
 it('falls back to the error name for anything else',()=>{
  expect(playError(new DOMException('boom','InvalidStateError'))).toBe('Không phát được audio (InvalidStateError).');
  expect(playError(new TypeError('x'))).toBe('Không phát được audio (TypeError).');
 });
});
