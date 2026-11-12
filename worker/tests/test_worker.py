import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main as worker


class WorkerTests(unittest.TestCase):
    def test_rejects_unsupported_protocol(self):
        with self.assertRaisesRegex(worker.WorkerError, 'protocol'):
            worker.validate_request({'protocol': 2, 'id': 'one', 'operation': 'health', 'payload': {}})

    def test_rejects_nonfinite_gain_and_negative_trim(self):
        for patch in [{'gain_db': float('nan')}, {'trim_start_ms': -1}, {'trim_end_ms': 0}]:
            with self.subTest(patch=patch), self.assertRaises(worker.WorkerError):
                worker.clip_recipe({'path': 'sample.wav', **patch}, 1000)

    def test_recipe_bounds_fade_and_duration(self):
        recipe = worker.clip_recipe({'path': 'x', 'trim_start_ms': 100, 'trim_end_ms': 900,
            'fade_in_ms': 10000, 'gap_ms': 200, 'gain_db': -3}, 1000)
        self.assertEqual(recipe['duration_ms'], 800)
        self.assertEqual(recipe['fade_in_ms'], 800)
        self.assertEqual(recipe['gap_ms'], 200)

    def test_model_digest_verifies_git_blob_and_sha256(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'sample'; path.write_bytes(b'abc')
            worker.verify_file(path, {'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()})
            worker.verify_file(path, {'size': 3, 'git_blob_sha1': hashlib.sha1(b'blob 3\0abc').hexdigest()})
            with self.assertRaisesRegex(worker.WorkerError, 'checksum'):
                worker.verify_file(path, {'size': 3, 'sha256': '0' * 64})

    def test_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(worker.WorkerError):
                worker.contained_path(Path(td), '../bad')

    def test_protocol_health_is_json_only(self):
        p = subprocess.run([sys.executable, str(ROOT / 'main.py')], input=json.dumps({
            'protocol': 1, 'id': 'test', 'operation': 'health', 'payload': {},
            'output_dir': tempfile.gettempdir(), 'models_dir': tempfile.gettempdir()}),
            text=True, capture_output=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        events = [json.loads(line) for line in p.stdout.splitlines()]
        self.assertEqual(events[-1]['event'], 'result')
        self.assertEqual(events[-1]['id'], 'test')

    def test_missing_model_reports_error_not_audio(self):
        with tempfile.TemporaryDirectory() as td:
            p = subprocess.run([sys.executable, str(ROOT / 'main.py')], input=json.dumps({
                'protocol': 1, 'id': 'test', 'operation': 'tts',
                'payload': {'text': 'Xin chào', 'model_path': td}, 'output_dir': td, 'models_dir': td}),
                text=True, capture_output=True)
            self.assertNotEqual(p.returncode, 0)
            e = json.loads(p.stdout.splitlines()[-1])
            self.assertEqual(e['event'], 'error')
            self.assertEqual(e['code'], 'MODEL_NOT_READY')
            self.assertEqual(list(Path(td).glob('*.wav')), [])

    def test_download_refuses_when_disk_is_too_small(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as td, \
                mock.patch.object(worker.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(10, 9, 1)):
            with self.assertRaises(worker.WorkerError) as ctx:
                worker.download({'model_id': 'whisper-small'}, Path(td), lambda *a: None)
            self.assertEqual(ctx.exception.code, 'DISK_FULL')
            self.assertFalse((Path(td) / 'whisper-small' / 'installed.json').exists())

    def test_take_peak_is_limited_below_full_scale(self):
        import numpy as np
        loud = np.array([0.2, 1.003, -1.2, 0.5], dtype=np.float32)
        out = worker.limit_peak(loud)
        self.assertAlmostEqual(float(np.abs(out).max()), worker.PEAK_CEILING, places=6)
        self.assertAlmostEqual(float(out[0] / out[3]), 0.4, places=6)  # whole take scaled, shape kept
        quiet = np.array([0.1, -0.9], dtype=np.float32)
        self.assertIs(worker.limit_peak(quiet), quiet)

    def test_preset_voices_sample_cooler_than_cloned_voices(self):
        self.assertEqual(worker.voice_kwargs({'voice_id': 'Ngoc'}), {'batch_size': 1, 'voice': 'Ngoc', 'temperature': 0.5})
        self.assertEqual(worker.voice_kwargs({}), {'batch_size': 1, 'temperature': 0.5})
        with tempfile.TemporaryDirectory() as td:
            ref = Path(td) / 'ref.wav'; ref.write_bytes(b'x')
            self.assertEqual(worker.voice_kwargs({'reference_path': str(ref), 'voice_id': 'Ngoc'}), {'batch_size': 1, 'ref_audio': str(ref)})
            with self.assertRaises(worker.WorkerError):
                worker.voice_kwargs({'reference_path': str(Path(td) / 'missing.wav')})

    def test_pause_marks_split_text_and_carry_silence(self):
        parts, trailing = worker.split_pauses('Xin chào. [nghỉ 0,5s] Tạm biệt [NGHỈ 250ms][nghỉ 1 giây]')
        self.assertEqual(parts, [('Xin chào.', 0.0), ('Tạm biệt', 0.5)])
        self.assertAlmostEqual(trailing, 1.25)
        self.assertEqual(worker.split_pauses('[nghỉ 2] Một câu.'), ([('Một câu.', 2.0)], 0.0))
        self.assertEqual(worker.split_pauses('Không có nghỉ [ghi chú]'), ([('Không có nghỉ [ghi chú]', 0.0)], 0.0))
        for bad in ['[nghỉ 0.01s] A', 'A [nghỉ 11s]', '[nghỉ 1s]']:
            with self.subTest(bad=bad), self.assertRaises(worker.WorkerError):
                worker.split_pauses(bad)

    def test_take_check_reports_word_errors_and_ignores_pause_marks(self):
        wer, spans = worker.compare_words('Chợ Bến Thành [nghỉ 1s] đông vui.', 'chợ biến thành, đông vui')
        self.assertEqual(spans, [{'expected': 'bến', 'heard': 'biến', 'soft': False}])
        self.assertAlmostEqual(wer, 0.2)
        self.assertEqual(worker.compare_words('Xin chào', 'xin chào.'), (0.0, []))
        wer, spans = worker.compare_words('giữa chợ trời xanh', 'giữa trợ chời sanh')  # merged initials only
        self.assertEqual((wer, [s['soft'] for s in spans]), (0.0, [True]))
        self.assertFalse(worker.compare_words('trời', 'chơi')[1][0]['soft'])  # tone differs: a real mismatch
        broken = worker.check_take(Path('missing.wav'), 'Xin chào', Path(tempfile.gettempdir()) / 'no-model')
        self.assertIn('error', broken)  # a check failure is reported, never raised

    def test_stt_progress_is_linear_in_audio_time(self):
        from types import SimpleNamespace
        from unittest import mock
        seg = lambda start, end: SimpleNamespace(start=start, end=end, text=' xin chào ')
        model = mock.Mock()
        model.transcribe.return_value = ([seg(0, 10), seg(10, 50), seg(50, 100)], SimpleNamespace(duration=100, language='vi'))
        seen = []
        import numpy as np
        with tempfile.TemporaryDirectory() as td, \
                mock.patch.object(worker, 'verify_model', return_value={'engine': 'faster-whisper'}), \
                mock.patch.object(worker, 'offline_mode'), \
                mock.patch.object(worker, 'load_audio', return_value=np.zeros(100 * worker.STT_RATE, dtype=np.float32)), \
                mock.patch.dict(sys.modules, {'faster_whisper': SimpleNamespace(WhisperModel=lambda *a, **k: model)}):
            source = Path(td) / 'a.wav'; source.write_bytes(b'x')
            result = worker.stt({'model_path': td, 'input_path': str(source)}, lambda v, m='': seen.append(v))
        self.assertEqual(seen, [0.05, 0.1, 0.5, 0.99])
        self.assertEqual(result['segments'][0]['text'], 'xin chào')

    def test_long_stt_input_is_cut_into_windows_at_quiet_points(self):
        import numpy as np
        rate = worker.STT_RATE
        audio = np.full(25 * 60 * rate, 0.5, dtype=np.float32)  # 25 min of loud signal
        quiet = (9 * 60 + 45) * rate  # one quiet 100 ms frame 15 s before the 10-minute mark
        audio[quiet:quiet + rate // 10] = 0
        cuts = worker.stt_windows(audio)
        self.assertEqual(cuts[0], 0)
        self.assertEqual(cuts[-1], len(audio))
        self.assertEqual(cuts[1], quiet + rate // 20)  # cut in the middle of the quiet frame
        self.assertTrue(all(b - a <= worker.STT_WINDOW_S * rate for a, b in zip(cuts, cuts[1:])))
        self.assertEqual(worker.stt_windows(audio[:rate]), [0, rate])  # short input: one window

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for actual speed test')
    def test_speed_change_keeps_pitch(self):
        import numpy as np
        tone = np.sin(2 * np.pi * 220 * np.arange(48000) / 48000).astype(np.float32) * 0.5
        fast = worker.stretch(tone, 1.25, shutil.which('ffmpeg'))
        self.assertAlmostEqual(len(fast) / 48000, 0.8, delta=0.02)
        spectrum = np.abs(np.fft.rfft(fast[4800:-4800]))
        self.assertAlmostEqual(np.argmax(spectrum) * 48000 / len(fast[4800:-4800]), 220, delta=3)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for actual render test')
    def test_actual_render_trim_gap_fade_atomic_output(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'tiếng Việt.wav'
            with wave.open(str(source), 'wb') as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
                w.writeframes(b'\x00\x10' * 48000)
            result = worker.render({'clips': [{'path': str(source), 'trim_start_ms': 100,
                'trim_end_ms': 600, 'gap_ms': 250, 'fade_in_ms': 50, 'fade_out_ms': 50}],
                'normalize': False, 'format': 'wav'}, Path(td), lambda *_: None)
            self.assertTrue(Path(result['path']).is_file())
            self.assertAlmostEqual(result['duration_ms'], 750, delta=2)
            self.assertEqual(result['sample_rate'], 48000)
            self.assertEqual(list(Path(td).glob('*.partial*')), [])


if __name__ == '__main__':
    unittest.main()
