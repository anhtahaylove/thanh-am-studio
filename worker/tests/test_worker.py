import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main as worker

# The VieNeu commit test_clone_preview_matches_what_synthesis_enrolls last passed against with the real model.
VIENEU_VERIFIED = '22dd2ef2a89bba24a77da6dbc84c75f7f4fda05b'

# Real-model separation tests: an installed models/htdemucs folder. Skipped when absent.
DEMUCS_MODELS = Path(os.environ.get('THANHAM_DEMUCS_MODELS', ''))


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
        self.assertIs(events[-1]['result']['torch_imported_by_engines'], False)

    def test_health_profiles_check_only_their_own_modules(self):
        self.assertEqual(set(worker.health('separation')['modules']), {'numpy', 'soundfile', 'torch', 'demucs.htdemucs', 'safetensors'})
        base = worker.health('base')
        self.assertNotIn('torch', base['modules'])
        self.assertEqual((base['profile'], base['torch_imported_by_engines']), ('base', False))
        with self.assertRaises(worker.WorkerError) as ctx:
            worker.health('nope')
        self.assertEqual(ctx.exception.code, 'INVALID_REQUEST')

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
        # the native worker, ONNX Runtime and the VC143 runtime (scripts/stage-worker.ps1) land beside main.py
        self.assertEqual(resources.get('../worker-rs/stage/'), 'worker/')

    def test_tts_refuses_an_unspaced_token_longer_than_the_cap(self):
        from unittest import mock
        cap = worker.MAX_TOKEN_CHARS
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), \
                mock.patch.object(worker, 'offline_mode', side_effect=RuntimeError('validated')):
            for text in ['Việt' * (cap // 4) + 'x', f'Xin chào {"a" * (cap + 1)}.']:
                with self.subTest(text=text[:12]), self.assertRaises(worker.WorkerError) as ctx:
                    worker.tts({'text': text}, Path(td), lambda *a: None)
                self.assertEqual(ctx.exception.code, 'INVALID_TEXT')
            # one bad segment refuses the whole batch, as the length check does
            with self.assertRaises(worker.WorkerError):
                worker.tts({'items': [{'text': 'Xin chào'}, {'text': 'b' * (cap + 1)}]}, Path(td), lambda *a: None, lambda *a, **k: None)
            # a token of exactly the cap, and long text of short words, pass the check (and reach the engine setup)
            for text in ['Việt' * (cap // 4), 'Xin chào ' * 2000, f'a　{"b" * cap}']:
                with self.subTest(n=len(text)), self.assertRaisesRegex(RuntimeError, 'validated'):
                    worker.tts({'text': text}, Path(td), lambda *a: None)

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
        for bad in ['[nghỉ abc]', '[pause 2 phút]', '[nghỉ giây]', '[nghỉ: 2s]', '[pause .5]', '[nghi 2 phút]']:
            with self.subTest(bad=bad):
                (chunk, pause), = worker.split_pauses(f'A {bad} B')[0]
                self.assertEqual((' '.join(chunk.split()), pause), ('A B', 0.0))
                with self.assertRaises(worker.WorkerError):
                    worker.split_pauses(bad)
        for text in ['[nghi ngờ]', '[Nghi vấn]', '[nghi lễ]']:
            self.assertEqual(worker.split_pauses(f'A {text} B'), ([(f'A {text} B', 0.0)], 0.0))
            self.assertEqual(worker.words(f'A {text} B'), worker.words(f'A {text[1:-1]} B'))
        self.assertEqual(worker.split_pauses('Nghỉ ngơi [pausex] nhé'), ([('Nghỉ ngơi [pausex] nhé', 0.0)], 0.0))
        with self.assertRaises(worker.WorkerError):
            worker.split_pauses('A [nghỉ 0] B')

    def test_a_dropped_pause_mark_leaves_one_space_between_words_and_none_at_the_edges(self):
        for text, spoken in [('Hôm nay [nghỉ abc] trời đẹp', 'Hôm nay trời đẹp'), ('Hôm nay[pause for effect]trời đẹp', 'Hôm nay trời đẹp'),
                             ('Hôm nay [nghỉ abc], trời đẹp', 'Hôm nay, trời đẹp'), ('Hôm nay  [nghỉ abc]   [pause x]  trời đẹp', 'Hôm nay trời đẹp'),
                             ('[nghỉ abc] Hôm nay', 'Hôm nay'), ('Hôm nay [nghỉ abc]', 'Hôm nay')]:
            with self.subTest(text=text):
                self.assertEqual(worker.split_pauses(text), ([(spoken, 0.0)], 0.0))
        self.assertEqual(worker.split_pauses('A [nghỉ abc] [nghỉ 1s] [pause x] B'), ([('A', 0.0), ('B', 1.0)], 0.0))

    def test_emotion_cues_are_left_to_the_engine_and_not_expected_as_words(self):
        for cue in ['[cười]', '[thở dài]', '[hắng giọng]', '[chuckle]', '[Sigh]', '[clear throat]', '[cuoi]', '[tho dai]', '[hang giong]', '[ cười ]']:
            with self.subTest(cue=cue):
                self.assertEqual(worker.split_pauses(f'Nghe hay quá {cue}. [nghỉ 1s] Thôi.'), ([(f'Nghe hay quá {cue}.', 0.0), ('Thôi.', 1.0)], 0.0))
                self.assertEqual(worker.words(f'Nghe hay {cue} quá'), ['nghe', 'hay', 'quá'])
        self.assertEqual(worker.split_pauses('[cười]'), ([('[cười]', 0.0)], 0.0))
        self.assertEqual(worker.words('Nghe [ghi chú] [thở  dài]'), ['nghe', 'ghi', 'chú', 'thở', 'dài'])

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

    def test_take_check_reports_when_each_heard_word_starts(self):
        from types import SimpleNamespace
        from unittest import mock
        word = lambda w, s: SimpleNamespace(word=w, start=s, end=s + 0.2)
        model = mock.Mock()
        model.transcribe.return_value = (iter([SimpleNamespace(text=' Xin chào.', words=[word(' Xin', 0.12), word(' chào.', 0.4104)]),
                                               SimpleNamespace(text=' Bạn khỏe', words=[word(' Bạn', 1.5), word(' khỏe', 1.75)])]), None)
        with mock.patch.dict(worker._CHECKERS, {Path('m'): model}):
            result = worker.check_take(Path('take.wav'), 'Xin chào. Bạn khỏe', Path('m'))
        self.assertEqual(model.transcribe.call_args.kwargs['word_timestamps'], True)
        self.assertEqual((result['heard'], result['wer']), ('Xin chào. Bạn khỏe', 0.0))
        self.assertEqual(result['words'], [{'text': 'Xin', 'start_ms': 120}, {'text': 'chào.', 'start_ms': 410},
                                           {'text': 'Bạn', 'start_ms': 1500}, {'text': 'khỏe', 'start_ms': 1750}])

    def test_chunks_of_words_that_are_also_english_keep_the_vietnamese_reading(self):
        def g2p(text):  # stands in for sea-g2p: English unless a Vietnamese-only word ('ơi') is present
            vi = 'ơi' in text
            return ' '.join({'y': 'ˈi' if vi else 'wˈaɪ', 'ơi': 'ˈəːj', 'ok': 'ˌoʊkˈeɪ'}.get(w.strip('.!?,'), w) for w in text.split()) + ('.' if text[-1] in '.!?' else '')
        read = worker.vietnamese_reading(g2p)
        self.assertEqual((read('y.'), read('y!'), read('y')), ('ˈi.', 'ˈi.', 'ˈi'))
        self.assertEqual(read('ok.'), 'ˌoʊkˈeɪ.')  # a real English word stays English
        for kept in ['Vâng.', '<en>y</en>.', '[sigh]', 'y [cười].', '.', 'y a b c.']:  # accents, tags, cues, no words, long chunks: untouched
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

    def test_clone_window_keeps_the_8_seconds_with_the_most_speech(self):
        import numpy as np
        sr = 16000
        tone = lambda s: (0.3 * np.sin(2 * np.pi * 220 * np.arange(int(s * sr)) / sr)).astype(np.float32)
        quiet = lambda s: np.zeros(int(s * sr), dtype=np.float32)
        self.assertEqual(worker.clone_window(tone(7.5), sr), (0, int(7.5 * sr)))  # not longer: all of it
        self.assertEqual(worker.clone_window(tone(12), sr), (0, 8 * sr))  # speech all through: the first 8 s, as before
        # Speech from the first sample keeps its first word even with a short pause right after it.
        self.assertEqual(worker.clone_window(np.concatenate([tone(0.3), quiet(0.1), tone(7.8), quiet(0.3)]), sr), (0, 8 * sr))
        self.assertEqual(worker.clone_window(np.concatenate([quiet(1), tone(10)]), sr), (int(0.96 * sr), int(8.96 * sr)))
        # The first best window starts 0.5 s into a pause; the start moves on to 40 ms before the next word.
        self.assertEqual(worker.clone_window(np.concatenate([tone(2), quiet(1), tone(7.5), quiet(0.7)]), sr),
                         (int(2.96 * sr), int(10.96 * sr)))
        # At 11025 Hz 20 ms frames do not divide 8 s; the last window wins here and still ends inside the clip at full length.
        r = 11025
        odd = np.concatenate([np.zeros(2 * r), 0.3 * np.sin(2 * np.pi * 220 * np.arange(7 * r) / r)]).astype(np.float32)
        self.assertEqual(worker.clone_window(odd, r), (len(odd) - 8 * r, len(odd)))
        # 5 s of speech, 3 s of silence, then 14 words of 0.6 s after 0.1 s pauses: more speech than the first 8 s.
        audio = np.concatenate([tone(5), quiet(3)] + [np.concatenate([quiet(0.1), tone(0.6)]) for _ in range(14)])
        start, end = worker.clone_window(audio, sr)
        self.assertEqual(end - start, 8 * sr)
        self.assertLessEqual(end, len(audio))
        # It starts 40 ms before a word, not inside one.
        self.assertLessEqual(min(abs(start + 0.04 * sr - (8.1 + 0.7 * k) * sr) for k in range(14)), 1)

    @unittest.skipUnless(importlib.util.find_spec('soundfile'), 'soundfile required')  # CI has numpy only
    def test_a_long_voice_sample_is_cloned_from_its_best_8_seconds_and_the_cut_is_removed(self):
        import numpy as np
        import soundfile as sf
        from types import SimpleNamespace
        from unittest import mock
        sr = 24000
        tone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(10 * sr) / sr)).astype(np.float32)
        audio = np.stack([np.concatenate([np.zeros(5 * sr, np.float32), tone])] * 2, axis=1)  # stereo, speech from 5 s
        seen = []
        def infer(text, **kw):
            data, rate = sf.read(kw['ref_audio'], dtype='float32', always_2d=True)
            seen.append((kw['ref_audio'], rate, data))
            return np.full(4800, 0.3, dtype=np.float32)
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=infer)),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock())}
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), \
                mock.patch.object(worker, 'offline_mode'), mock.patch.dict(sys.modules, fakes):
            long, short, broken = (str(Path(td) / name) for name in ['long.wav', 'short.wav', 'broken.wav'])
            sf.write(long, audio, sr, subtype='FLOAT')
            sf.write(short, audio[:7 * sr], sr, subtype='FLOAT')
            Path(broken).write_bytes(b'not audio')
            self.assertEqual(worker.clone_reference(short), short)
            self.assertEqual(worker.clone_reference(broken), broken)  # VieNeu reports it as before
            items = [{'text': 'Xin chào.', 'reference_path': long, 'output_name': f'{i}.wav'} for i in range(2)]
            worker.tts({'model_path': td, 'items': items}, Path(td) / 'out', lambda *a: None, lambda i, **k: self.assertIn('result', k))
            # Cut once for the batch: the 8 s from 40 ms before the speech, both channels, same rate; deleted afterwards.
            self.assertEqual(len({path for path, _, _ in seen}), 1)
            for path, rate, data in seen:
                self.assertEqual(rate, sr)
                np.testing.assert_array_equal(data, audio[5 * sr - 960:13 * sr - 960])
                self.assertFalse(Path(path).exists())
            self.assertTrue(Path(long).exists())  # the user's sample stays

    @unittest.skipUnless(importlib.util.find_spec('soundfile'), 'soundfile required')  # CI has numpy only; runtime.yml runs it
    def test_preview_and_synthesis_hand_vieneu_the_same_crop(self):
        import numpy as np
        import soundfile as sf
        from types import SimpleNamespace
        from unittest import mock
        sr = 24000
        audio = np.concatenate([np.zeros(5 * sr), 0.3 * np.sin(2 * np.pi * 220 * np.arange(10 * sr) / sr)]).astype(np.float32)
        engine_got, precleaned, denoised = [], [], []
        def infer(text, **kw):
            engine_got.append(sf.read(kw['ref_audio'], dtype='float32')[0])
            return np.full(4800, 0.3, dtype=np.float32)
        def preclean(ref_audio, *, top_db=30, out_path=None):  # identity, recording what it was handed
            data, rate = sf.read(ref_audio, dtype='float32')
            precleaned.append(data)
            sf.write(out_path, data, rate, subtype='FLOAT')
            return str(out_path)
        class Denoiser:
            def __init__(self, path):
                self.path = path
            def denoise(self, wav, rate):
                denoised.append((self.path, wav, rate))
                return wav
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=infer)),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text,
                                                   V3TurboVieNeuTTS=SimpleNamespace(_preclean_reference_audio=preclean)),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock(), _MAX_REF_SECONDS=8.0),
                 'vieneu._v3_turbo_engine.onnx_denoiser': SimpleNamespace(OnnxDenoiser=Denoiser)}
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as temp, mock.patch.object(tempfile, 'tempdir', temp), \
                mock.patch.object(worker, 'verify_model'), mock.patch.object(worker, 'offline_mode'), mock.patch.dict(sys.modules, fakes):
            reference = str(Path(td) / 'mẫu.wav')
            sf.write(reference, audio, sr, subtype='FLOAT')
            worker.tts({'model_path': td, 'text': 'Xin chào.', 'reference_path': reference, 'output_name': 'take.wav'}, Path(td) / 'out', lambda *a: None)
            result = worker.clone_preview({'model_path': td, 'reference_path': reference, 'output_name': 'preview.wav'}, Path(td) / 'out', lambda *a: None)
            np.testing.assert_array_equal(precleaned[0], engine_got[0])  # the preview cleans what synthesis hands VieNeu
            self.assertEqual(len(precleaned[0]), 8 * sr)
            path, wav, rate = denoised[0]
            self.assertEqual((Path(path), rate), (Path(td) / 'backbone' / 'denoiser.onnx', sr))
            np.testing.assert_array_equal(wav, precleaned[0][:8 * sr])
            self.assertEqual((sf.info(result['path']).samplerate, sf.info(result['path']).subtype, result['sample_rate']), (44100, 'PCM_24', 44100))
            self.assertEqual(sorted(p.name for p in (Path(td) / 'out').iterdir()), ['preview.wav', 'take.wav'])
            self.assertEqual(list(Path(temp).iterdir()), [])  # crop and trimmed copy deleted
            # A failure right after the crop is cut (here: no room for the trimmed copy) still deletes the crop.
            real_mkstemp = tempfile.mkstemp
            def no_trim_file(*a, **k):
                if k.get('prefix') == 'clone-trim-':
                    raise OSError('disk full')
                return real_mkstemp(*a, **k)
            with mock.patch.object(tempfile, 'mkstemp', no_trim_file), self.assertRaises(OSError):
                worker.clone_preview({'model_path': td, 'reference_path': reference, 'output_name': 'again.wav'}, Path(td) / 'out', lambda *a: None)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_clone_preview_needs_the_reference_file(self):
        from unittest import mock
        worker.validate_request({'protocol': 1, 'id': 'one', 'operation': 'clone_preview', 'payload': {}})
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), self.assertRaises(worker.WorkerError) as caught:
            worker.clone_preview({'model_path': td, 'reference_path': str(Path(td) / 'gone.wav')}, Path(td) / 'out', lambda *a: None)
        self.assertEqual(caught.exception.code, 'INPUT_MISSING')

    def test_vieneu_pin_was_verified(self):
        pin = re.search(r'VieNeu-TTS\.git@([0-9a-f]{40})', (ROOT / 'requirements-base.lock').read_text(encoding='utf-8')).group(1)
        self.assertEqual(pin, VIENEU_VERIFIED, 'The vieneu pin changed: run test_clone_preview_matches_what_synthesis_enrolls with '
                         'THANHAM_VIENEU_MODELS set to an installed vieneu-v3 folder, then update VIENEU_VERIFIED.')

    @unittest.skipUnless(os.environ.get('THANHAM_VIENEU_MODELS'), 'needs THANHAM_VIENEU_MODELS = an installed vieneu-v3 model folder')
    def test_clone_preview_matches_what_synthesis_enrolls(self):
        import numpy as np
        import soundfile as sf
        from unittest import mock
        from vieneu._v3_turbo_engine.onnx_denoiser import OnnxDenoiser
        models = os.environ['THANHAM_VIENEU_MODELS']
        sr = 24000
        t = np.arange(12 * sr) / sr
        # A noisy, syllable-gated harmonic tone after 1 s of near silence: something to trim, crop and denoise.
        voiced = (np.sin(2 * np.pi * 3 * t) > -0.3) * (t > 1)
        tone = sum(np.sin(2 * np.pi * 180 * k * t) / k for k in range(1, 6))
        audio = (0.2 * voiced * tone + 0.01 * np.random.default_rng(0).standard_normal(len(t))).astype(np.float32)
        captured, original = [], OnnxDenoiser.denoise
        def capture(self, wav, rate):
            captured.append(original(self, wav, rate))
            return captured[-1]
        with tempfile.TemporaryDirectory() as td, mock.patch.object(OnnxDenoiser, 'denoise', capture):
            reference = str(Path(td) / 'reference.wav')
            sf.write(reference, audio, sr, subtype='PCM_16')
            worker.tts({'model_path': models, 'text': 'Xin chào.', 'reference_path': reference, 'output_name': 'take.wav'}, Path(td) / 'out', lambda *a: None)
            preview = worker.clone_preview({'model_path': models, 'reference_path': reference, 'output_name': 'preview.wav'}, Path(td) / 'out', lambda *a: None)
            data, rate = sf.read(preview['path'], dtype='float32')
        self.assertEqual((rate, len(captured)), (44100, 2))
        self.assertEqual(len(data), len(captured[0]))
        self.assertTrue(np.allclose(data, captured[0], atol=1e-4), float(np.abs(data - captured[0]).max()))

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

    def test_tts_seed_hook_reseeds_numpy_before_every_engine_call(self):
        import numpy as np
        import zlib
        from types import SimpleNamespace
        from unittest import mock
        draws = []
        engine = SimpleNamespace(infer=lambda **kw: np.random.random_sample())
        def infer(text, **kw):  # two engine calls per part, as for a part read in two chunks
            draws.append((engine.infer(), engine.infer()))
            return np.full(4800, 0.3, dtype=np.float32)
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=infer, engine=engine)),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock()),
                 'soundfile': SimpleNamespace(write=lambda path, *a, **k: Path(path).write_bytes(b'RIFF'))}
        items = [{'text': 'A. [nghỉ 0.2s] B.', 'output_name': 'a.wav'}, {'text': 'C.', 'output_name': 'b.wav'}]
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), mock.patch.object(worker, 'offline_mode'), \
                mock.patch.dict(sys.modules, fakes), mock.patch.dict(os.environ, {'THANHAM_TTS_SEED': '7'}):
            worker.tts({'model_path': td, 'items': items}, Path(td) / 'out', lambda *a: None, lambda i, **v: None)
        drawn = lambda name, call: np.random.RandomState(zlib.crc32(f'7|{name}|{call}'.encode())).random_sample()
        self.assertEqual(draws, [(drawn('a.wav', 1), drawn('a.wav', 2)), (drawn('a.wav', 3), drawn('a.wav', 4)),
                                 (drawn('b.wav', 1), drawn('b.wav', 2))])

    def test_tts_at_another_speed_keeps_the_reading_before_the_speed_change(self):
        import numpy as np
        from types import SimpleNamespace
        from unittest import mock
        written = {}
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=lambda text, **kw: np.full(4800, 0.3, dtype=np.float32))),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock()),
                 'soundfile': SimpleNamespace(write=lambda path, data, *a, **k: (written.__setitem__(Path(path).name, len(data)), Path(path).write_bytes(b'RIFF')))}
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), mock.patch.object(worker, 'offline_mode'), \
                mock.patch.object(worker, 'executable', return_value='ffmpeg'), mock.patch.object(worker, 'stretch', lambda a, speed, ff: a[::2]), \
                mock.patch.dict(sys.modules, fakes):
            text = '[nghỉ 0.5s] Xin chào. [nghỉ 0.2s]'
            fast = worker.tts({'model_path': td, 'text': text, 'speed': 2, 'output_name': 'a.wav'}, Path(td) / 'out', lambda *a: None)
            plain = worker.tts({'model_path': td, 'text': text, 'output_name': 'b.wav'}, Path(td) / 'out', lambda *a: None)
            self.assertTrue(Path(fast['raw_path']).is_file())
        # Take: 0.5 s, the reading at 2x (2400 samples), 0.2 s. Before the change: pauses x2 around the 4800-sample reading.
        self.assertEqual((written['a.partial.wav'], written['a.raw.partial.wav'], Path(fast['raw_path']).name, fast['speed']),
                         (24000 + 2400 + 9600, 48000 + 4800 + 19200, 'a.raw.wav', 2))
        self.assertNotIn('raw_path', plain)
        self.assertNotIn('b.raw.partial.wav', written)

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

    @unittest.skipUnless(importlib.util.find_spec('faster_whisper') and shutil.which('ffmpeg'), 'faster-whisper and FFmpeg required (the private runtime)')
    def test_stt_decode_keeps_going_past_invalid_frames(self):
        import random
        import numpy as np
        from faster_whisper.audio import decode_audio
        with tempfile.TemporaryDirectory() as td:
            def tone(name, rate=44100, channels=1, codec=('-c:a', 'libmp3lame', '-b:a', '64k')):  # a 10 s synthetic tone
                path = Path(td) / name
                subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                                f'sine=frequency=440:sample_rate={rate}:duration=10', '-ac', str(channels), *codec, str(path)], check=True)
                return path.read_bytes()

            def seconds(data, suffix='.mp3'):
                path = Path(td) / f'input{suffix}'
                path.write_bytes(data)
                return len(worker.load_audio(path)) / worker.STT_RATE

            data = tone('tone.mp3')
            mid = len(data) // 2
            self.assertAlmostEqual(seconds(data), 10, delta=0.1)
            # The second file's ID3 tag is an invalid frame: faster-whisper's decode_audio stopped there, at 10 s.
            self.assertAlmostEqual(seconds(data + data), 20, delta=0.2)
            # 400 bytes of 0xff lose the frames they hit, not the second half (5 s before).
            self.assertAlmostEqual(seconds(data[:mid] + b'\xff' * 400 + data[mid + 400:]), 10, delta=0.2)
            # A part with more channels is decoded (the FIFO takes the first ones, as before).
            self.assertAlmostEqual(seconds(data + tone('stereo.mp3', channels=2)), 20, delta=0.2)
            # A part with another rate or fewer channels is an error, not a transcript cut short or a crash.
            for joined in (data + tone('22k.mp3', rate=22050), tone('stereo.mp3', channels=2) + data):
                with self.assertRaisesRegex(ValueError, 'Frame does not match AudioFifo parameters'):
                    seconds(joined)
            # 4096 bytes of 0xff in AAC: the decoder's ADTS parse codes are UndefinedErrors in PyAV, skipped too (5.1 s before).
            m4a = tone('tone.m4a', codec=('-c:a', 'aac', '-b:a', '128k'))
            self.assertGreater(seconds(m4a[:len(m4a) // 2] + b'\xff' * 4096 + m4a[len(m4a) // 2 + 4096:], '.m4a'), 9)
            # Every packet invalid (the packet table in moov kept): an input error, not an empty transcript reported as success.
            at = m4a.index(b'mdat')
            end = at - 4 + int.from_bytes(m4a[at - 4:at], 'big')
            with self.assertRaises(worker.WorkerError) as caught:
                seconds(m4a[:at + 4] + b'\xff' * (end - at - 4) + m4a[end:], '.m4a')
            self.assertEqual((caught.exception.code, str(caught.exception)), ('INVALID_MEDIA', 'The file has no decodable audio.'))
            # Two damaged regions: the first is skipped, then the AAC decoder returns EPERM on the second. That ends the input
            # there instead of failing the job, so it is no worse than decode_audio, which stopped at the first (2.6 s).
            a, b = len(m4a) // 4, len(m4a) * 65 // 100
            path = Path(td) / 'two.m4a'
            path.write_bytes(m4a[:a] + bytes(range(256)) * 2 + m4a[a + 512:b] + random.Random(0).randbytes(4096) + m4a[b + 4096:])
            self.assertGreaterEqual(len(worker.load_audio(path)), len(decode_audio(str(path), sampling_rate=16000)))
            # An ADTS header of length 0 is the demuxer's InvalidDataError: the input ends there, as in decode_audio.
            adts, starts, pos = bytearray(tone('tone.aac', codec=('-c:a', 'aac', '-b:a', '128k'))), [], 0
            while pos + 7 <= len(adts):
                starts.append(pos)
                pos += (adts[pos + 3] & 3) << 11 | adts[pos + 4] << 3 | adts[pos + 5] >> 5
            at = starts[len(starts) // 2]
            adts[at + 3], adts[at + 4], adts[at + 5] = adts[at + 3] & 0xfc, 0, adts[at + 5] & 0x1f
            path = Path(td) / 'badlen.aac'
            path.write_bytes(adts)
            np.testing.assert_array_equal(worker.load_audio(path), decode_audio(str(path), sampling_rate=16000))
            self.assertAlmostEqual(len(worker.load_audio(path)) / worker.STT_RATE, 5, delta=0.5)

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
    def test_actual_render_fits_a_sped_up_take_to_its_cue_with_one_stretch(self):
        import numpy as np
        import soundfile as sf
        ffmpeg = shutil.which('ffmpeg')
        t = np.arange(48000) / 48000
        reading = (0.4 * np.sin(2 * np.pi * (150 + 400 * t) * t) * (1 + np.sin(2 * np.pi * 3 * t)) / 2).astype(np.float32)
        take = worker.stretch(reading, 1.25, ffmpeg)  # what TTS wrote at speed 1.25
        with tempfile.TemporaryDirectory() as td:
            sf.write(str(Path(td) / 'take.wav'), take, 48000, subtype='FLOAT')
            sf.write(str(Path(td) / 'raw.wav'), reading, 48000, subtype='FLOAT')
            clip = {'path': str(Path(td) / 'take.wav'), 'raw_path': str(Path(td) / 'raw.wav'), 'speed': 1.25,
                    'trim_start_ms': 0, 'trim_end_ms': None, 'at_ms': 0, 'rate': 1.5}
            result = worker.render({'clips': [clip], 'normalize': False, 'format': 'wav', 'timeline': True, 'pad_to_ms': 0},
                Path(td), lambda *_: None)
            out, _ = sf.read(result['path'], dtype='float32')
        once, twice = worker.stretch(reading, 1.875, ffmpeg), worker.stretch(take, 1.5, ffmpeg)
        n = min(len(out), len(once), len(twice)) - 2400
        error = lambda ref: float(np.sqrt(np.mean((out[:n] - ref[:n]) ** 2)))
        self.assertAlmostEqual(len(out) / 48, 1000 / 1.875, delta=5)
        self.assertLess(error(once), 1e-3)
        self.assertGreater(error(twice), 1e-2)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for actual render test')
    def test_actual_render_of_a_sped_up_take_with_many_pauses_keeps_every_part_in_place(self):
        import numpy as np
        import soundfile as sf
        from types import SimpleNamespace
        from unittest import mock
        # Each spoken part: 0.8 s of sound and 0.2 s of silence, like a TTS reading; atempo shortens such a part by 17-28 ms.
        reading = np.concatenate([0.4 * np.sin(2 * np.pi * 220 * np.arange(38400) / 48000), np.zeros(9600)]).astype(np.float32)
        fakes = {'vieneu': SimpleNamespace(Vieneu=lambda **k: SimpleNamespace(infer=lambda text, **kw: reading)),
                 'vieneu.v3turbo': SimpleNamespace(phonemize_text_with_emotions=lambda text: text),
                 'vieneu._v3_turbo_engine': mock.Mock(),
                 'vieneu._v3_turbo_engine.onnx_runtime_lite': SimpleNamespace(OnnxV3LiteEngine=mock.Mock())}
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model'), mock.patch.object(worker, 'offline_mode'), \
                mock.patch.dict(sys.modules, fakes):
            take = worker.tts({'model_path': td, 'text': ' [nghỉ 0.3s] '.join(['Câu.'] * 8), 'speed': 0.85, 'output_name': 'a.wav'},
                Path(td) / 'out', lambda *a: None)
            clip = {'path': take['path'], 'trim_start_ms': take['speech_start_ms'], 'trim_end_ms': take['speech_end_ms'], 'at_ms': 0, 'rate': 1.5}
            once, twice = (sf.read(worker.render({'clips': [c], 'normalize': False, 'format': 'wav', 'timeline': True, 'pad_to_ms': 0},
                Path(td), lambda *_: None)['path'], dtype='float32')[0] for c in ({**clip, 'raw_path': take['raw_path'], 'speed': 0.85}, clip))
        loud = lambda a: np.abs(a[:len(a) // 480 * 480]).reshape(-1, 480).max(axis=1) > 0.05  # 10 ms frames
        a, b = loud(once), loud(twice)
        n = min(len(a), len(b))
        # One stretch must keep the parts where two stretches put them (the same 10 ms frames loud) and keep the last one whole.
        self.assertLessEqual(int(np.sum(a[:n] != b[:n])), 4)
        self.assertGreaterEqual(np.flatnonzero(a)[-1], np.flatnonzero(b)[-1] - 1)

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

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required for actual render test')
    def test_actual_render_writes_every_export_format_with_its_codec(self):
        import numpy as np
        import soundfile as sf
        # codec, duration tolerance in ms (lossy encoders pad frames), bits per raw sample (FLAC only), container
        expected = {'wav': ('pcm_s24le', 2, None, 'wav'), 'mp3': ('mp3', 60, None, 'mp3'), 'm4a': ('aac', 30, None, 'mov,mp4,m4a,3gp,3g2,mj2'),
            'flac': ('flac', 2, '24', 'flac'), 'opus': ('opus', 30, None, 'ogg')}
        self.assertEqual(set(expected), set(worker.EXPORT_CODECS))
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / 'câu.wav'
            # 3 s: loudnorm treats shorter input as one block, so only a longer one shows the 100 ms frames
            sf.write(str(source), (0.25 * np.sin(np.arange(3 * 48000) * 2 * np.pi * 220 / 48000)).astype(np.float32), 48000)
            for (fmt, (codec, tolerance, bits, container)), normalize in itertools.product(expected.items(), (False, True)):
                with self.subTest(fmt=fmt, normalize=normalize):  # loudnorm emits 100 ms frames; the container must not round up to them
                    result = worker.render({'clips': [{'path': str(source), 'trim_start_ms': 0, 'trim_end_ms': None, 'gap_ms': 250}],
                        'normalize': normalize, 'format': fmt}, Path(td), lambda *_: None)
                    self.assertEqual(Path(result['path']).suffix, '.' + fmt)
                    probed = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                        'stream=codec_name,sample_rate,channels,bits_per_raw_sample,bit_rate:format=format_name', '-of', 'json', result['path']], capture_output=True, check=True).stdout)
                    stream, name = probed['streams'][0], probed['format']['format_name']
                    self.assertEqual((stream['codec_name'], stream['sample_rate'], stream['channels'], name), (codec, '48000', 1, container))
                    if bits:
                        self.assertEqual(stream['bits_per_raw_sample'], bits)
                    if fmt == 'mp3':
                        self.assertEqual(int(stream['bit_rate']), 192000)
                    if fmt == 'm4a':  # +faststart: the index (moov) is written before the audio data (mdat)
                        data = Path(result['path']).read_bytes()
                        self.assertTrue(0 <= data.find(b'moov') < data.find(b'mdat'))
                    self.assertAlmostEqual(result['duration_ms'], 3250, delta=tolerance)
                    self.assertEqual(result['sample_rate'], 48000)
            self.assertEqual(list(Path(td).glob('*.partial*')), [])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required for actual render test')
    def test_actual_render_mixes_the_background_under_the_dub_at_0_db(self):
        import numpy as np
        import soundfile as sf
        db = lambda a: 20 * np.log10(np.sqrt(np.mean(np.square(a, dtype=np.float64))))
        with tempfile.TemporaryDirectory() as td:
            voice = Path(td) / 'câu.wav'
            sf.write(str(voice), (0.5 * np.sin(2 * np.pi * 1000 * np.arange(48000) / 48000)).astype(np.float32), 48000)  # 1 s
            t = np.arange(6 * 44100) / 44100  # a 6 s stem as separate writes it: 44.1 kHz stereo 24-bit FLAC, peaks at -18 dBFS
            bed = (0.126 * np.stack([np.sin(2 * np.pi * 110 * t), np.sin(2 * np.pi * 165 * t)], axis=1)).astype(np.float32)
            sf.write(str(Path(td) / 'nền dài.flac'), bed, 44100, subtype='PCM_24')
            sf.write(str(Path(td) / 'nền lặng.flac'), np.zeros((2 * 44100, 2), np.float32), 44100, subtype='PCM_24')  # 2 s
            loudness = []  # of the normalised render, by loudnorm's meter as the plain path's target (ebur128 reads this signal 0.9 LU higher)
            def render(background=None, normalize=False):
                result = worker.render({'clips': [{'path': str(voice), 'at_ms': 500, 'rate': 1}, {'path': str(voice), 'at_ms': 2500, 'rate': 1}],
                    'normalize': normalize, 'format': 'wav', 'timeline': True, 'pad_to_ms': 4000,
                    **({'background_path': str(Path(td) / background)} if background else {})}, Path(td), lambda *_: None)
                audio, rate = sf.read(result['path'], dtype='float32', always_2d=True)
                self.assertEqual(rate, 48000)
                if normalize:
                    loudness.append(worker.loudness(shutil.which('ffmpeg'), ['-i', result['path']], '[0:a]anull'))
                return audio
            plain, silent, bedded, normalised = render(), render('nền lặng.flac'), render('nền dài.flac'), render('nền dài.flac', True)
            self.assertEqual(list(Path(td).glob('*.partial*')), [])
        self.assertEqual([a.shape[1] for a in (plain, silent, bedded, normalised)], [1, 2, 2, 2])
        # A shorter background stops and the dub runs on to pad_to_ms; a longer one runs to its own end.
        self.assertAlmostEqual(len(silent) / 48, 4000, delta=2)
        self.assertAlmostEqual(len(bedded) / 48, 6000, delta=2)
        self.assertAlmostEqual(len(normalised) / 48, 6000, delta=2)
        self.assertTrue(np.isfinite(normalised).all() and np.abs(normalised).max() <= 1)
        for at in (500, 2500):
            take = slice(at * 48, (at + 1000) * 48)
            # The first sample above half the peak around the take's start (half: the bed alone, at a quarter, never reaches it).
            onset = lambda a, ch: (lambda w: int(np.argmax(w > 0.5 * w.max())))(np.abs(a[(at - 100) * 48:(at + 100) * 48, ch]))
            for ch in (0, 1):
                # Both channels carry the voice at its own level (pan, not aformat's -3 dB upmix) and at the same place (limiter delay compensated).
                self.assertAlmostEqual(db(silent[take, ch]), db(plain[take, 0]), delta=0.5)
                self.assertLessEqual(abs(onset(bedded, ch) - onset(plain, 0)), 48)
                self.assertLessEqual(abs(onset(normalised, ch) - onset(plain, 0)), 48)
        for ch in (0, 1):  # between the takes only the background plays, at its own level
            self.assertAlmostEqual(db(bedded[1600 * 48:2400 * 48, ch]), db(bed[:, ch]), delta=0.5)
        # Normalised, the mix gets one gain: each line stands as far above the bed as unnormalised, and the bed does not swell
        # through a gap (late in it vs right after a line), unlike loudnorm's dynamic single pass.
        span = lambda a, ch, a_ms, z_ms: db(a[a_ms * 48:z_ms * 48, ch])
        shape = lambda a, ch: [span(a, ch, 600, 1400) - span(a, ch, 1600, 2400), span(a, ch, 2600, 3400) - span(a, ch, 3600, 5900),
            span(a, ch, 2200, 2400) - span(a, ch, 1520, 1720), span(a, ch, 5500, 5900) - span(a, ch, 3520, 3820)]
        for ch in (0, 1):
            for got, want in zip(shape(normalised, ch), shape(bedded, ch)):
                self.assertAlmostEqual(got, want, delta=0.5)
        self.assertAlmostEqual(loudness[0], -16, delta=0.5)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required for actual render test')
    def test_actual_render_exports_a_kept_background_as_m4a_with_the_wav_length_and_levels(self):
        import numpy as np
        import soundfile as sf
        db = lambda a: 20 * np.log10(np.sqrt(np.mean(np.square(a, dtype=np.float64))))
        def decode(path):  # the AAC stream as 48 kHz stereo float, the way a player gets it
            raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-f', 'f32le', '-ar', '48000', '-ac', '2', 'pipe:1'],
                capture_output=True, check=True).stdout
            return np.frombuffer(raw, np.float32).reshape(-1, 2)
        with tempfile.TemporaryDirectory() as td:
            voice = Path(td) / 'câu.wav'
            sf.write(str(voice), (0.5 * np.sin(2 * np.pi * 1000 * np.arange(48000) / 48000)).astype(np.float32), 48000)  # 1 s
            t = np.arange(6 * 44100) / 44100  # a 6 s stem as separate writes it: 44.1 kHz stereo 24-bit FLAC
            bed = (0.126 * np.stack([np.sin(2 * np.pi * 110 * t), np.sin(2 * np.pi * 165 * t)], axis=1)).astype(np.float32)
            sf.write(str(Path(td) / 'nền.flac'), bed, 44100, subtype='PCM_24')
            for normalize in (False, True):
                with self.subTest(normalize=normalize):
                    paths = {}
                    for fmt in ('wav', 'm4a'):
                        result = worker.render({'clips': [{'path': str(voice), 'at_ms': 500, 'rate': 1}, {'path': str(voice), 'at_ms': 2500, 'rate': 1}],
                            'normalize': normalize, 'format': fmt, 'timeline': True, 'pad_to_ms': 4000,
                            'background_path': str(Path(td) / 'nền.flac')}, Path(td), lambda *_: None)
                        paths[fmt] = result['path']
                    probed = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                        'stream=codec_name,channels:format=format_name,duration', '-of', 'json', paths['m4a']], capture_output=True, check=True).stdout)
                    self.assertEqual((probed['streams'][0]['codec_name'], probed['streams'][0]['channels'], probed['format']['format_name']),
                        ('aac', 2, 'mov,mp4,m4a,3gp,3g2,mj2'))
                    wav = sf.read(paths['wav'], dtype='float32', always_2d=True)[0]
                    m4a = decode(paths['m4a'])
                    # The container and the decoded stream both keep the WAV's length (no rounding up to loudnorm's 100 ms frames).
                    self.assertAlmostEqual(len(wav) / 48, 6000, delta=2)
                    self.assertAlmostEqual(float(probed['format']['duration']) * 1000, len(wav) / 48, delta=2)
                    self.assertAlmostEqual(len(m4a) / 48, len(wav) / 48, delta=2)
                    for ch in (0, 1):  # between the takes only the background plays, in both channels, at the WAV's level (AAC: 1 dB)
                        between = slice(1600 * 48, 2400 * 48)
                        self.assertAlmostEqual(db(m4a[between, ch]), db(wav[between, ch]), delta=1)
                        if not normalize:
                            self.assertAlmostEqual(db(m4a[between, ch]), db(bed[:, ch]), delta=1)
            self.assertEqual(list(Path(td).glob('*.partial*')), [])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required for actual render test')
    def test_actual_render_limits_a_loud_background_mix_below_full_scale_in_place(self):
        import numpy as np
        import soundfile as sf
        t = np.arange(48000) / 48000
        voice = (0.9 * np.sin(2 * np.pi * (300 + 1350 * t) * t)).astype(np.float32)  # a 1 s chirp: no period, so one lag fits it
        tb = np.arange(3 * 44100) / 44100
        with tempfile.TemporaryDirectory() as td:
            sf.write(str(Path(td) / 'câu.wav'), voice, 48000, subtype='FLOAT')
            sf.write(str(Path(td) / 'nền.flac'), np.repeat(0.5 * np.sin(2 * np.pi * 110 * tb)[:, None], 2, axis=1).astype(np.float32), 44100, subtype='PCM_24')
            def render(**extra):
                result = worker.render({'clips': [{'path': str(Path(td) / 'câu.wav'), 'at_ms': 1000, 'rate': 1}], 'normalize': False, 'format': 'wav',
                    'timeline': True, 'pad_to_ms': 0, **extra}, Path(td), lambda *_: None)
                return sf.read(result['path'], dtype='float32', always_2d=True)[0]
            plain, mixed = render(), render(background_path=str(Path(td) / 'nền.flac'))
        # Voice 0.9 over a bed of 0.5 would reach 1.4: the limiter holds it at 0.98 (a little more allowed for its lookahead).
        self.assertLessEqual(float(np.abs(mixed).max()), 0.99)
        voice_at = np.zeros(len(mixed))
        voice_at[:len(plain)] = plain[:, 0]
        edge = slice(980 * 48, 1200 * 48)  # the line's start, where the limiter's gain moves most
        lag = lambda ch: int(np.argmax([np.dot(mixed[edge, ch], np.roll(voice_at, d)[edge]) for d in range(-480, 481)])) - 480
        lags = [lag(0), lag(1)]
        self.assertTrue(all(abs(d) <= 48 for d in lags), f'lag in samples {lags}')

    def test_render_refuses_a_background_without_the_subtitle_timeline(self):
        from unittest import mock
        with mock.patch.object(worker, 'executable', return_value='ffmpeg'), self.assertRaises(worker.WorkerError) as ctx:
            worker.render({'clips': [{'path': 'x.wav'}], 'format': 'wav', 'background_path': 'nền.flac'}, Path('.'), lambda *_: None)
        self.assertEqual(ctx.exception.code, 'INVALID_BACKGROUND')

    def test_render_rejects_a_format_it_cannot_write_and_lists_the_five(self):
        for bad in ['ogg', 'aac', 'wma']:
            with self.subTest(fmt=bad), self.assertRaisesRegex(worker.WorkerError, r'wav, mp3, m4a, flac, opus') as ctx:
                worker.render({'clips': [{'path': 'x.wav'}], 'format': bad}, Path('.'), lambda *_: None)
            self.assertEqual(ctx.exception.code, 'INVALID_RECIPE')

    def test_replace_retries_a_file_an_antivirus_scan_holds_briefly(self):
        from unittest import mock
        real, calls = worker.os.replace, []
        def flaky(src, dst):
            calls.append(src)
            if len(calls) <= 2:
                raise PermissionError(13, 'The process cannot access the file because it is being used by another process')
            real(src, dst)
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker.os, 'replace', flaky), mock.patch.object(worker.time, 'sleep') as sleep:
            a, b = Path(td, 'a'), Path(td, 'b'); a.write_text('x')
            worker.replace_with_retry(a, b)
            self.assertEqual(b.read_text(), 'x'); self.assertFalse(a.exists()); self.assertEqual(len(calls), 3); self.assertEqual(sleep.call_count, 2)

    def test_replace_gives_up_with_the_last_error_after_a_bounded_wait(self):
        from unittest import mock
        with mock.patch.object(worker.os, 'replace', side_effect=PermissionError(13, 'locked')) as rep, mock.patch.object(worker.time, 'sleep') as sleep:
            with self.assertRaises(PermissionError):
                worker.replace_with_retry('a', 'b')
            self.assertGreater(rep.call_count, 2); self.assertLess(sum(c.args[0] for c in sleep.call_args_list), 2)

    def test_replace_does_not_retry_other_errors(self):
        from unittest import mock
        with mock.patch.object(worker.os, 'replace', side_effect=FileNotFoundError('gone')) as rep, mock.patch.object(worker.time, 'sleep') as sleep:
            with self.assertRaises(FileNotFoundError):
                worker.replace_with_retry('a', 'b')
            self.assertEqual(rep.call_count, 1); sleep.assert_not_called()

    def test_crossfade_windows_give_an_identity_separator_its_input_back_exactly(self):
        import numpy as np
        size, overlap = 1000, 100
        def reader(audio):
            pos = [0]
            def read(n):
                pos[0] += n
                return audio[pos[0] - n:pos[0]]
            return read
        for frames in (500, 1000, 1001, 2300):  # half a window, one, one and a sample, 2.3
            with self.subTest(frames=frames):
                audio, out, starts = np.random.default_rng(frames).standard_normal((frames, 2)).astype(np.float32), [], []
                worker.crossfade_windows(reader(audio), lambda chunk, start: starts.append(start) or chunk, out.append, size, overlap)
                self.assertTrue(np.array_equal(np.concatenate(out), audio))
                self.assertEqual(starts, list(range(0, frames - overlap, size - overlap)))
        out = []  # each window's output fades into the next one's over the shared frames
        worker.crossfade_windows(reader(np.zeros((2300, 2), np.float32)), lambda chunk, start: np.full_like(chunk, start), out.append, size, overlap)
        out = np.concatenate(out)[:, 0]
        self.assertTrue((out[:900] == 0).all() and (out[1000:1800] == 900).all() and (out[1900:] == 1800).all())
        self.assertTrue((np.diff(out[899:1001]) > 0).all() and (np.diff(out[1799:1901]) > 0).all())
        for bad in (0, size, size + 1):
            with self.subTest(overlap=bad), self.assertRaisesRegex(ValueError, 'shorter than the window'):
                worker.crossfade_windows(reader(np.zeros((10, 2), np.float32)), lambda chunk, start: chunk, print, size, bad)

    def test_background_is_the_mix_without_the_vocals_and_progress_never_goes_back(self):
        import numpy as np
        calls, progress = [], []
        def run(mix, callback):  # a four-source separator that segments like Demucs: every 300 frames, start and end
            calls.append(mix)
            for offset in range(0, mix.shape[1], 300):
                callback({'segment_offset': offset, 'state': 'start'}); callback({'segment_offset': offset, 'state': 'end'})
            return np.stack([mix * 0.5, mix * 0.25, mix * 0.25, mix * 9])
        audio = np.tile(np.array([[0.5, -0.25], [-0.5, 0.25]], np.float32), (1150, 1))  # every window's mono mix has mean 0
        pos, out = [0], []
        def read(n):
            pos[0] += n
            return audio[pos[0] - n:pos[0]]
        separator = worker.background_separator(['drums', 'bass', 'other', 'vocals'], run, len(audio), lambda value, message: progress.append(value))
        worker.crossfade_windows(read, separator, out.append, 1000, 100)
        np.testing.assert_allclose(np.concatenate(out), audio, atol=1e-6)
        self.assertAlmostEqual(float(np.abs(calls[0]).max()), 4.0, places=5)  # the model gets the window at unit deviation
        self.assertEqual(progress, sorted(set(progress)))
        self.assertEqual(progress[-1], 2100 / 2300)

    def test_background_keeps_the_mix_dc_once(self):
        import numpy as np
        voice = 0.5 * np.sin(2 * np.pi * 100 * np.arange(4410) / 44100)  # 10 whole periods: no DC
        mix = np.stack([voice + 0.1, voice + 0.1], axis=1).astype(np.float32)
        ideal = lambda norm, callback: np.stack([norm * 0, norm * 0, norm * 0, norm])  # all but the DC is the voice
        background = worker.background_separator(['drums', 'bass', 'other', 'vocals'], ideal, len(mix), lambda *a: None)(mix, 0)
        np.testing.assert_allclose(background, 0.1, atol=1e-5)  # the input's DC, not once per kept source

    def test_separation_refuses_short_memory_or_disk_before_loading_the_model(self):
        from unittest import mock
        gib = 2**30
        with tempfile.TemporaryDirectory() as td, mock.patch.object(worker, 'verify_model', return_value={'artifacts': [{'path': 'm.safetensors'}]}), \
                mock.patch.object(worker, 'executable', return_value='ffmpeg'), mock.patch.object(worker, 'probe', return_value={'path': 'in.wav', 'duration_ms': 600_000}), \
                mock.patch.object(worker, 'demucs_model', side_effect=AssertionError('model loaded')):
            # 10 min of stem: 2 x 151 MiB (job file and asset copy) + 256 MiB to spare = 559 MiB.
            for memory, free, expected in [((1.4 * gib, 8 * gib), 99 * gib, 'LOW_MEMORY'), ((8 * gib, 2.4 * gib), 99 * gib, 'LOW_MEMORY'),
                                           ((8 * gib, 8 * gib), 550 * 2**20, 'DISK_FULL'), ((1.5 * gib, 2.5 * gib), 570 * 2**20, None)]:
                with self.subTest(memory=memory, free=free), mock.patch.object(worker, 'memory_status', return_value=memory), \
                        mock.patch.object(worker.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(2 * free, free, free)):
                    with self.assertRaises(AssertionError if expected is None else worker.WorkerError) as ctx:
                        worker.separate({'input_path': 'in.wav', 'model_path': td}, Path(td) / 'out', lambda *a: None)
                    self.assertEqual(getattr(ctx.exception, 'code', None), expected)
        if sys.platform == 'win32':
            self.assertTrue(all(value > 0 for value in worker.memory_status()))

    @unittest.skipUnless(importlib.util.find_spec('demucs') and shutil.which('ffmpeg'), 'torch, demucs and FFmpeg required (the CPU runtime)')
    def test_separate_runs_a_random_htdemucs_end_to_end(self):
        from fractions import Fraction
        from unittest import mock
        import numpy as np
        import soundfile as sf
        import torch
        from demucs.htdemucs import HTDemucs
        from safetensors.torch import save_file
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            # Saved as demucs' Hugging Face export does, with untrained weights: the real class and code path, small and no download.
            kwargs = {'sources': ['drums', 'bass', 'other', 'vocals'], 'samplerate': 44100, 'channels': 8, 't_layers': 1,
                      'segment': {'_type': 'fraction', 'numerator': 39, 'denominator': 5}}
            torch.manual_seed(0)
            save_file(HTDemucs(**{**kwargs, 'segment': Fraction(39, 5)}).state_dict(), str(td / 'm.safetensors'),
                      metadata={'klass': 'demucs.htdemucs.HTDemucs', 'args': '[]', 'kwargs': json.dumps(kwargs)})
            sf.write(str(td / 'noise.wav'), np.random.default_rng(0).uniform(-0.5, 0.5, (3 * 44100, 2)), 44100, subtype='PCM_16')
            progress = []
            with mock.patch.object(worker, 'verify_model', return_value={'artifacts': [{'path': 'm.safetensors'}]}), \
                    mock.patch.object(worker, 'SEPARATE_WINDOW_S', 1.0), mock.patch.object(worker, 'SEPARATE_CROSSFADE_S', 0.25):
                result = worker.separate({'input_path': str(td / 'noise.wav'), 'model_path': str(td), 'output_name': 'bg.flac'},
                                         td / 'out', lambda value, message: progress.append(value))
            info, audio = sf.info(result['path']), sf.read(result['path'], dtype='float32')[0]
            self.assertEqual((info.format, info.subtype, info.samplerate, info.channels, info.frames), ('FLAC', 'PCM_24', 44100, 2, 3 * 44100))
            self.assertEqual((result['duration_ms'], result['sample_rate']), (3000, 44100))
            self.assertTrue(np.isfinite(audio).all() and np.abs(audio).max() > 0)
            self.assertEqual(progress, sorted(progress))
            self.assertEqual([p.name for p in (td / 'out').iterdir()], ['bg.flac'])
            # Any other class in the metadata is refused before it is built, and so is a `structure` (it names classes to import).
            for i, metadata in enumerate([{'klass': 'demucs.demucs.Demucs'}, {'klass': 'demucs.htdemucs.HTDemucs', 'structure': '{"_class": "collections.OrderedDict"}'}]):
                save_file({'x': torch.zeros(1)}, str(td / f'other{i}.safetensors'), metadata={**metadata, 'args': '[]', 'kwargs': '{}'})
                with self.subTest(metadata=metadata), self.assertRaises(worker.WorkerError) as ctx:
                    worker.demucs_model(td / f'other{i}.safetensors')
                self.assertEqual(ctx.exception.code, 'MODEL_UNKNOWN')


def tone_bed(seconds, seed=0):
    """Stereo 44.1 kHz music without a voice at -18 dBFS RMS: irregular plucked tones (three harmonics, decaying)."""
    import numpy as np
    rng, rate = np.random.default_rng(seed), 44100
    bed, t, at = np.zeros((int(seconds * rate), 2)), np.arange(int(0.6 * rate)) / rate, 0
    while at < len(bed):
        f = rng.choice([110, 147, 196, 220, 262, 330, 392, 440])
        note = sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 2, 3)) * np.exp(-5 * t)
        n = min(len(t), len(bed) - at)
        bed[at:at + n] += note[:n, None] * [1, rng.uniform(0.5, 1)]
        at += int(rng.uniform(0.12, 0.45) * rate)
    return (bed * 10 ** (-18 / 20) / np.sqrt(np.mean(bed ** 2))).astype(np.float32)


@unittest.skipUnless((DEMUCS_MODELS / 'installed.json').is_file(), 'set THANHAM_DEMUCS_MODELS to an installed models/htdemucs folder')
class RealSeparationTests(unittest.TestCase):
    def separate(self, audio, td, window_s=worker.SEPARATE_WINDOW_S):
        from unittest import mock
        import soundfile as sf
        sf.write(str(Path(td) / 'in.wav'), audio, 44100, subtype='FLOAT')
        with mock.patch.object(worker, 'SEPARATE_WINDOW_S', window_s):
            result = worker.separate({'input_path': str(Path(td) / 'in.wav'), 'model_path': str(DEMUCS_MODELS)}, Path(td) / 'out', lambda *a: None)
        return sf.read(result['path'], dtype='float32')[0]

    def test_a_tone_bed_without_a_voice_keeps_its_level(self):
        import numpy as np
        bed = tone_bed(20)
        with tempfile.TemporaryDirectory() as td:
            stem = self.separate(bed, td)
        self.assertEqual(stem.shape, bed.shape)
        for at in range(0, len(bed), 5 * 44100):  # every 5 s within +-3 dB of the bed
            level = 10 * np.log10(np.mean(stem[at:at + 5 * 44100] ** 2) / np.mean(bed[at:at + 5 * 44100] ** 2))
            self.assertLess(abs(level), 3, f'{at / 44100:.0f} s: {level:+.1f} dB')

    def test_60_s_windows_match_the_whole_track(self):
        import numpy as np
        audio = tone_bed(150) + np.random.default_rng(1).normal(0, 0.01, (150 * 44100, 2)).astype(np.float32)
        with tempfile.TemporaryDirectory() as td:
            windowed = self.separate(audio, td)
        with tempfile.TemporaryDirectory() as td:
            whole = self.separate(audio, td, window_s=200.0)
        windowed, whole = windowed.ravel().astype(np.float64), whole.ravel().astype(np.float64)
        target = whole * (windowed @ whole) / (whole @ whole)
        self.assertGreaterEqual(10 * np.log10((target @ target) / np.sum((windowed - target) ** 2)), 30)


if __name__ == '__main__':
    unittest.main()
