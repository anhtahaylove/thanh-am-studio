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


def diarize_child_here(calls):
    """Stand-in for subprocess.run in diarize_isolated(): does the child's work in this process, where the sherpa_onnx mock is."""
    def run(args, **kwargs):
        import diarize
        import numpy as np
        model, *counts = json.loads(args[-1]); calls.append(counts)
        Path(args[-2]).write_text(json.dumps(diarize.diarize(np.load(args[-3]), Path(model), *counts)), encoding='utf-8')
        return subprocess.CompletedProcess(args, 0, b'', b'')
    return run


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

    def test_every_worker_module_ships_in_the_installer(self):
        resources = json.loads((ROOT.parent / 'src-tauri' / 'tauri.conf.json').read_text(encoding='utf-8'))['bundle']['resources']
        for module in ROOT.glob('*.py'):
            with self.subTest(module=module.name):
                self.assertEqual(resources.get(f'../worker/{module.name}'), f'worker/{module.name}')

    def test_pause_marks_split_text_and_carry_silence(self):
        parts, trailing = worker.split_pauses('Xin chào. [nghỉ 0,5s] Tạm biệt [NGHỈ 250ms][nghỉ 1 giây]')
        self.assertEqual(parts, [('Xin chào.', 0.0), ('Tạm biệt', 0.5)])
        self.assertAlmostEqual(trailing, 1.25)
        self.assertEqual(worker.split_pauses('[nghỉ 2] Một câu.'), ([('Một câu.', 2.0)], 0.0))
        self.assertEqual(worker.split_pauses('Không có nghỉ [ghi chú]'), ([('Không có nghỉ [ghi chú]', 0.0)], 0.0))
        for bad in ['[nghỉ 0.01s] A', 'A [nghỉ 11s]', '[nghỉ 1s]']:
            with self.subTest(bad=bad), self.assertRaises(worker.WorkerError):
                worker.split_pauses(bad)

    def test_pause_mark_aliases_bare_tag_and_dropped_malformed_marks(self):
        for mark, seconds in [('[nghỉ]', 1.0), ('[nghi]', 1.0), ('[PAUSE]', 1.0), ('[nghi 2s]', 2.0), ('[pause 2 sec]', 2.0), ('[Pause 1,5 seconds]', 1.5),
                              ('[nghỉ 2 giay]', 2.0), ('[nghỉ 2 second]', 2.0), ('[ nghỉ 300 ms ]', 0.3)]:
            with self.subTest(mark=mark):
                self.assertEqual(worker.split_pauses(f'A {mark} B'), ([('A', 0.0), ('B', seconds)], 0.0))
        for bad in ['[nghỉ abc]', '[pause 2 phút]', '[nghỉ giây]', '[nghỉ: 2s]', '[pause .5]']:
            with self.subTest(bad=bad):
                (chunk, pause), = worker.split_pauses(f'A {bad} B')[0]
                self.assertEqual((' '.join(chunk.split()), pause), ('A B', 0.0))
                with self.assertRaises(worker.WorkerError):
                    worker.split_pauses(bad)
        self.assertEqual(worker.split_pauses('Nghỉ ngơi [pausex] nhé'), ([('Nghỉ ngơi [pausex] nhé', 0.0)], 0.0))
        with self.assertRaises(worker.WorkerError):
            worker.split_pauses('A [nghỉ 0] B')

    def test_take_check_expects_no_words_of_any_pause_mark(self):
        self.assertEqual(worker.words('Xin [nghỉ] chào [pause 2 sec] bạn [nghi 1s][nghỉ abc]'), ['xin', 'chào', 'bạn'])

    def test_take_check_reports_word_errors_and_ignores_pause_marks(self):
        wer, spans = worker.compare_words('Chợ Bến Thành [nghỉ 1s] đông vui.', 'chợ biến thành, đông vui')
        self.assertEqual(spans, [{'expected': 'bến', 'heard': 'biến', 'soft': False}])
        self.assertAlmostEqual(wer, 0.2)
        self.assertEqual(worker.compare_words('Xin chào', 'xin chào.'), (0.0, []))
        self.assertEqual(worker.compare_words('Cứ do <en>it</en> đi, <en>push code</en>.', 'cứ do it đi, push code'), (0.0, []))
        wer, spans = worker.compare_words('giữa chợ trời xanh', 'giữa trợ chời sanh')  # merged initials only
        self.assertEqual((wer, [s['soft'] for s in spans]), (0.0, [True]))
        self.assertFalse(worker.compare_words('trời', 'chơi')[1][0]['soft'])  # tone differs: a real mismatch
        broken = worker.check_take(Path('missing.wav'), 'Xin chào', Path(tempfile.gettempdir()) / 'no-model')
        self.assertIn('error', broken)  # a check failure is reported, never raised

    def test_chunks_of_words_that_are_also_english_keep_the_vietnamese_reading(self):
        def g2p(text):  # stands in for sea-g2p: English unless a Vietnamese-only word ('ơi') is present
            vi = 'ơi' in text
            return ' '.join({'y': 'ˈi' if vi else 'wˈaɪ', 'ơi': 'ˈəːj', 'ok': 'ˌoʊkˈeɪ'}.get(w.strip('.!?,'), w) for w in text.split()) + ('.' if text[-1] in '.!?' else '')
        read = worker.vietnamese_reading(g2p)
        self.assertEqual((read('y.'), read('y!'), read('y')), ('ˈi.', 'ˈi.', 'ˈi'))
        self.assertEqual(read('ok.'), 'ˌoʊkˈeɪ.')  # a real English word stays English
        for kept in ['Vâng.', '<en>y</en>.', '[sigh]', '.', 'y a b c.']:  # accents, tags, cues, no words, long chunks: untouched
            self.assertEqual(read(kept), g2p(kept))

    def test_tts_reads_single_english_looking_words_in_vietnamese(self):
        import numpy as np
        from types import SimpleNamespace
        from unittest import mock
        v3turbo = SimpleNamespace(phonemize_text_with_emotions=lambda text: 'ˈi ˈəːj.' if 'ơi' in text else 'wˈaɪ.')
        engine = SimpleNamespace(infer=lambda text, **kw: np.full(4800, 0.1, dtype=np.float32))
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: engine), 'vieneu.v3turbo': v3turbo,
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock()),
                 'soundfile': SimpleNamespace(write=lambda path, *a, **k: Path(path).write_bytes(b'RIFF'))}  # CI has no soundfile
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'),                 mock.patch.object(worker, 'offline_mode'), mock.patch.dict(sys.modules, fakes):
            worker.tts({'model_path': td, 'text': 'y.'}, Path(td) / 'out', lambda *a: None)
        self.assertEqual(v3turbo.phonemize_text_with_emotions('y.'), 'ˈi.')

    def test_speech_edges_leave_out_silence_with_a_margin(self):
        import numpy as np
        audio = np.concatenate([np.zeros(14400), np.full(48000, 0.5), np.full(4800, 0.004), np.zeros(24000)]).astype(np.float32)
        # Speech is 300-1300 ms; the 0.004 tail is under 2 % of the peak, so it counts as silence. 80 ms margin each side.
        self.assertEqual(worker.speech_edges(audio), (220, 1380))
        self.assertEqual(worker.speech_edges(audio, keep_start=True, keep_end=True), (0, None))
        self.assertEqual(worker.speech_edges(np.full(4800, 0.5, dtype=np.float32)), (0, None))  # no silence to cut
        self.assertEqual(worker.speech_edges(np.zeros(4800, dtype=np.float32)), (0, None))

    def test_tts_reports_speech_edges_but_keeps_pause_marks_at_the_edges(self):
        import numpy as np
        from types import SimpleNamespace
        from unittest import mock
        speech = np.concatenate([np.zeros(9600), np.full(24000, 0.3), np.zeros(14400)]).astype(np.float32)  # 200 ms in, 300 ms out
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=lambda text, **kw: speech)),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock()),
                 'soundfile': SimpleNamespace(write=lambda path, *a, **k: Path(path).write_bytes(b'RIFF'))}
        results = []
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'),                 mock.patch.object(worker, 'offline_mode'), mock.patch.dict(sys.modules, fakes):
            for i, text in enumerate(['Xin chào.', '[nghỉ 0.5s] Xin chào. [nghỉ 0.3s]']):
                results.append(worker.tts({'model_path': td, 'text': text, 'output_name': f'{i}.wav'}, Path(td) / 'out', lambda *a: None))
        self.assertEqual([(r['speech_start_ms'], r['speech_end_ms'], r['duration_ms']) for r in results],
                         [(120, 780, 1000), (0, None, 1800)])

    def test_real_g2p_reads_a_lone_y_as_the_vietnamese_letter(self):
        try:
            from vieneu_utils.phonemize_text import phonemize_text_with_emotions as g2p
        except ImportError:
            self.skipTest('the engine is not installed')
        read = worker.vietnamese_reading(g2p)
        self.assertEqual([read(t) for t in ['y.', 'in.', 'u.', 'im.']], ['ˈi.', 'ˈin.', 'ˈu.', 'ˈim.'])
        self.assertEqual(read('Xin chào.'), g2p('Xin chào.'))

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
        self.assertFalse(model.transcribe.call_args.kwargs['word_timestamps'])  # no word-timing cost without speakers

    def test_stt_with_speakers_splits_a_row_where_the_speaker_changes(self):
        from types import SimpleNamespace
        from unittest import mock
        import numpy as np
        w = lambda start, end, text: SimpleNamespace(start=start, end=end, word=text)
        segment = SimpleNamespace(start=0, end=4, text=' Xin chào. Vâng.', words=[w(0, 1, ' Xin'), w(1, 2, ' chào.'), w(2, 4, ' Vâng.')])
        model = mock.Mock()
        model.transcribe.return_value = ([segment], SimpleNamespace(duration=4, language='vi'))
        sherpa = mock.Mock()  # the diarization engine finds speaker 0 until 2 s, then speaker 1
        sherpa.OfflineSpeakerDiarization.return_value.sample_rate = 16000
        sherpa.OfflineSpeakerDiarization.return_value.process.return_value.sort_by_start_time.return_value = [
            SimpleNamespace(start=0, end=2, speaker=0), SimpleNamespace(start=2, end=4, speaker=1)]
        calls = []  # the speaker counts each diarization child got: [num, min, max]
        with tempfile.TemporaryDirectory() as td,                 mock.patch.object(subprocess, 'run', side_effect=diarize_child_here(calls)), \
                mock.patch.object(worker, 'verify_model', return_value={'engine': 'faster-whisper'}), \
                mock.patch.object(worker, 'offline_mode'), \
                mock.patch.object(worker, 'load_audio', return_value=np.zeros(4 * worker.STT_RATE, dtype=np.float32)), \
                mock.patch.dict(sys.modules, {'faster_whisper': SimpleNamespace(WhisperModel=lambda *a, **k: model), 'sherpa_onnx': sherpa}):
            for name in ('segmentation/model.onnx', 'embedding/model.onnx'):
                (Path(td) / name).parent.mkdir(parents=True, exist_ok=True); (Path(td) / name).write_bytes(b'')
            source = Path(td) / 'a.wav'; source.write_bytes(b'x')
            payload = {'model_path': td, 'input_path': str(source), 'diarize_model_path': td}
            result = worker.stt(payload, lambda *a: None)
            worker.stt({**payload, 'num_speakers': 2}, lambda *a: None)
            worker.stt({**payload, 'min_speakers': 2, 'max_speakers': 3}, lambda *a: None)
            sherpa.OfflineSpeakerDiarization.side_effect = RuntimeError('engine failed')
            fallback = worker.stt(payload, lambda *a: None)
        self.assertTrue(model.transcribe.call_args.kwargs['word_timestamps'])
        # A known count is sent as min = max, so an automatic result with that many speakers is kept.
        self.assertEqual(calls[:3], [[None, None, None], [None, 2, 2], [None, 2, 3]])
        self.assertNotIn('diarize_error', result)
        self.assertEqual(result['segments'], [{'start': 0, 'end': 2, 'text': 'Xin chào.', 'speaker': 0},
                                              {'start': 2, 'end': 4, 'text': 'Vâng.', 'speaker': 1}])
        # A diarization failure keeps the whole rows, without speakers.
        self.assertEqual((fallback['segments'], fallback['diarize_error']), ([{'start': 0, 'end': 4, 'text': 'Xin chào. Vâng.'}], 'engine failed'))

    def test_stt_with_speakers_survives_an_empty_word_alignment(self):
        from types import SimpleNamespace
        from unittest import mock
        import numpy as np
        segment = SimpleNamespace(start=0, end=4, text=' Xin chào. Vâng.', words=None)
        def segments(with_words):  # faster-whisper 1.2.1 raises mid-generator on CTranslate2's empty alignment
            yield segment
            if with_words:
                raise IndexError('index 0 is out of bounds for axis 0 with size 0')
        model = mock.Mock()
        model.transcribe.side_effect = lambda *a, **k: (segments(k['word_timestamps']), SimpleNamespace(duration=4, language='vi'))
        sherpa = mock.Mock()
        sherpa.OfflineSpeakerDiarization.return_value.sample_rate = 16000
        sherpa.OfflineSpeakerDiarization.return_value.process.return_value.sort_by_start_time.return_value = [
            SimpleNamespace(start=0, end=1, speaker=0), SimpleNamespace(start=1, end=4, speaker=1)]
        with tempfile.TemporaryDirectory() as td,                 mock.patch.object(subprocess, 'run', side_effect=diarize_child_here([])), \
                mock.patch.object(worker, 'verify_model', return_value={'engine': 'faster-whisper'}), \
                mock.patch.object(worker, 'offline_mode'), \
                mock.patch.object(worker, 'load_audio', return_value=np.zeros(4 * worker.STT_RATE, dtype=np.float32)), \
                mock.patch.dict(sys.modules, {'faster_whisper': SimpleNamespace(WhisperModel=lambda *a, **k: model), 'sherpa_onnx': sherpa}):
            for name in ('segmentation/model.onnx', 'embedding/model.onnx'):
                (Path(td) / name).parent.mkdir(parents=True, exist_ok=True); (Path(td) / name).write_bytes(b'')
            source = Path(td) / 'a.wav'; source.write_bytes(b'x')
            result = worker.stt({'model_path': td, 'input_path': str(source), 'diarize_model_path': td}, lambda *a: None)
            with self.assertRaises(IndexError):  # without speakers nothing asks for word times, so a real error stays one
                model.transcribe.side_effect = lambda *a, **k: (segments(True), SimpleNamespace(duration=4, language='vi'))
                worker.stt({'model_path': td, 'input_path': str(source)}, lambda *a: None)
        self.assertEqual([c.kwargs['word_timestamps'] for c in model.transcribe.call_args_list[:2]], [True, False])
        self.assertNotIn('diarize_error', result)
        self.assertEqual(result['segments'], [{'start': 0, 'end': 4, 'text': 'Xin chào. Vâng.', 'speaker': 1}])  # whole row kept

    def test_stt_rejects_a_speaker_count_outside_1_to_8_before_transcribing(self):
        for bad in [0, 9, 2.5, '2', True]:
            with self.subTest(bad=bad), self.assertRaises(worker.WorkerError) as ctx:
                worker.stt({'model_path': 'missing', 'input_path': 'missing.wav', 'num_speakers': bad}, lambda *a: None)
            self.assertEqual(ctx.exception.code, 'INVALID_RECIPE')
        for bad in [{'min_speakers': 0}, {'max_speakers': 9}, {'num_speakers': 2, 'max_speakers': 3}, {'min_speakers': 4, 'max_speakers': 3}]:
            with self.subTest(bad=bad), self.assertRaises(worker.WorkerError) as ctx:
                worker.stt({'model_path': 'missing', 'input_path': 'missing.wav', **bad}, lambda *a: None)
            self.assertEqual(ctx.exception.code, 'INVALID_RECIPE')
        with self.assertRaises(worker.WorkerError) as ctx:  # a valid count gets past the check
            worker.stt({'model_path': 'missing', 'input_path': 'missing.wav', 'num_speakers': 2}, lambda *a: None)
        self.assertNotEqual(ctx.exception.code, 'INVALID_RECIPE')

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
    def test_actual_render_places_clips_on_the_subtitle_timeline(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'câu.wav'
            sf.write(str(source), np.full(48000, 0.25, dtype=np.float32), 48000)  # 1 s of sound
            clip = {'path': str(source), 'trim_start_ms': 0, 'trim_end_ms': None, 'gap_ms': 300}
            result = worker.render({'clips': [{**clip, 'at_ms': 500, 'rate': 1}, {**clip, 'at_ms': 2000, 'rate': 1.25}],
                'normalize': False, 'format': 'wav', 'timeline': True, 'pad_to_ms': 3500}, Path(td), lambda *_: None)
            audio, rate = sf.read(result['path'], dtype='float32')
        loud = np.abs(audio) > 0.1
        ms = lambda a, b: loud[a * 48:b * 48]
        # Clip 1 at 500-1500 ms, the gap is not used; clip 2 waits until 2000 ms and lasts 1 s / 1.25; silence pads to 3500 ms.
        self.assertEqual(rate, 48000)
        self.assertAlmostEqual(len(audio) / 48, 3500, delta=2)
        self.assertTrue(ms(520, 1480).all() and ms(2020, 2780).all())
        self.assertFalse(ms(0, 480).any() or ms(1520, 1980).any() or ms(2820, 3500).any())

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
