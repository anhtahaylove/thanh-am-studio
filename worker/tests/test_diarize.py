import os
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import diarize

# Real-model test inputs: the installed models/diarization folder and a mono WAV in which
# THANHAM_DIARIZE_TEST_SPEAKERS (default 2) people talk in turns. Skipped when absent.
MODEL_DIR = Path(os.environ.get('THANHAM_DIARIZATION_MODELS', ''))
TEST_WAV = Path(os.environ.get('THANHAM_DIARIZE_TEST_WAV', ''))
MODELS_READY = MODEL_DIR.is_dir() and all((MODEL_DIR / n).is_file() for n in (diarize.SEGMENTATION_FILE, diarize.EMBEDDING_FILE))


def row(start, end):
    return {'start': start, 'end': end, 'text': 'x'}


def turn(start, end, speaker):
    return {'start': start, 'end': end, 'speaker': speaker}


class AssignSpeakersTests(unittest.TestCase):
    def test_picks_speaker_with_most_overlap(self):
        turns = [turn(0, 3, 0), turn(3, 10, 1)]
        self.assertEqual(diarize.assign_speakers([row(0, 2), row(2, 7), row(8, 9)], turns), [0, 1, 1])

    def test_sums_overlap_across_several_turns_of_one_speaker(self):
        turns = [turn(0, 2, 0), turn(2, 5, 1), turn(5, 7, 0), turn(7, 8, 1)]
        self.assertEqual(diarize.assign_speakers([row(1, 8)], turns), [1])  # 0: 1+2 s, 1: 3+1 s
        self.assertEqual(diarize.assign_speakers([row(0, 7)], turns), [0])  # 0: 2+2 s, 1: 3 s

    def test_overlapped_speech_counts_both_speakers(self):
        turns = [turn(0, 6, 0), turn(4, 10, 1)]
        self.assertEqual(diarize.assign_speakers([row(3, 9)], turns), [1])  # 0: 3 s, 1: 5 s

    def test_exact_tie_prefers_lower_speaker_number(self):
        self.assertEqual(diarize.assign_speakers([row(0, 4)], [turn(0, 2, 1), turn(2, 4, 0)]), [0])

    def test_row_in_a_gap_takes_nearest_turn(self):
        turns = [turn(0, 2, 0), turn(10, 12, 1)]
        self.assertEqual(diarize.assign_speakers([row(3, 4), row(8, 9)], turns), [0, 1])

    def test_touching_boundary_is_not_overlap(self):
        self.assertEqual(diarize.assign_speakers([row(2, 4)], [turn(0, 2, 0), turn(6, 8, 1)]), [0])

    def test_no_turns_or_no_rows(self):
        self.assertEqual(diarize.assign_speakers([row(0, 1)], []), [0])
        self.assertEqual(diarize.assign_speakers([], [turn(0, 1, 0)]), [])


class DiarizeInputTests(unittest.TestCase):
    def test_rejects_bad_audio_and_speaker_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            for audio in (np.zeros(0, np.float32), np.zeros((2, 16000), np.float32), np.full(16000, np.nan, np.float32)):
                with self.subTest(shape=audio.shape), self.assertRaises(ValueError):
                    diarize.diarize(audio, Path(tmp))
            with self.assertRaises(ValueError):
                diarize.diarize(np.zeros(16000, np.float32), Path(tmp), num_speakers=0)

    def test_missing_model_files_raise_before_any_import(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(FileNotFoundError, 'model.onnx'):
            diarize.diarize(np.zeros(16000, np.float32), Path(tmp))


@unittest.skipUnless(MODELS_READY, 'set THANHAM_DIARIZATION_MODELS to an installed models/diarization folder')
class RealModelTests(unittest.TestCase):
    def test_silence_gives_no_turns(self):
        self.assertEqual(diarize.diarize(np.zeros(16000 * 5, np.float32), MODEL_DIR), [])

    @unittest.skipUnless(TEST_WAV.is_file(), 'set THANHAM_DIARIZE_TEST_WAV to a mono 16 kHz WAV with alternating speakers')
    def test_alternating_speakers_are_separated(self):
        import soundfile as sf
        audio, rate = sf.read(str(TEST_WAV), dtype='float32')
        self.assertEqual((audio.ndim, rate), (1, 16000))
        expected = int(os.environ.get('THANHAM_DIARIZE_TEST_SPEAKERS', '2'))
        turns = diarize.diarize(audio, MODEL_DIR)
        self.assertEqual(len({t['speaker'] for t in turns}), expected)
        forced = diarize.diarize(audio, MODEL_DIR, num_speakers=expected)
        self.assertEqual(len({t['speaker'] for t in forced}), expected)
        self.assertTrue(all(0 <= t['start'] < t['end'] <= len(audio) / 16000 + 0.5 for t in turns))


if __name__ == '__main__':
    unittest.main()
