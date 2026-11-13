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


class KnownSpeakerCountTests(unittest.TestCase):
    def run_with(self, results, count):
        """Run diarize() with the engine replaced: `results` maps a requested cluster count to its turns."""
        asked = []

        def fake(audio, model_dir, clusters):
            asked.append(clusters)
            return results[clusters]
        original = diarize._turns
        diarize._turns = fake
        try:
            with tempfile.TemporaryDirectory() as tmp:
                for name in (diarize.SEGMENTATION_FILE, diarize.EMBEDDING_FILE):
                    (Path(tmp) / name).parent.mkdir(parents=True, exist_ok=True)
                    (Path(tmp) / name).write_bytes(b'')
                return diarize.diarize(np.zeros(16000, np.float32), Path(tmp), count), asked
        finally:
            diarize._turns = original

    def test_asks_for_more_clusters_when_one_is_lost(self):
        # Two clusters gave one speaker (the other cluster was an outlier with no surviving turn).
        lost = [turn(0, 5, 0), turn(6, 9, 0)]
        three = [turn(0, 5, 0), turn(5, 5.2, 1), turn(6, 9, 2)]
        turns, asked = self.run_with({2: lost, 3: three}, 2)
        self.assertEqual(asked, [2, 3])
        self.assertEqual(turns, [turn(0, 5, 0), turn(6, 9, 1)])

    def test_stops_at_the_first_count_that_is_enough(self):
        turns, asked = self.run_with({2: [turn(0, 1, 0), turn(1, 2, 1)]}, 2)
        self.assertEqual((asked, len({t['speaker'] for t in turns})), ([2], 2))

    def test_gives_up_after_two_extra_clusters(self):
        one = [turn(0, 9, 0)]
        turns, asked = self.run_with({2: one, 3: one, 4: one}, 2)
        self.assertEqual((asked, turns), ([2, 3, 4], one))

    def test_a_tiny_cluster_does_not_count_as_a_speaker(self):
        # Two clusters: one held almost everything, the other a 0.1 s outlier, so two people were merged.
        merged = [turn(0, 9, 0), turn(9, 9.1, 1)]
        three = [turn(0, 5, 0), turn(5, 9, 1), turn(9, 9.1, 2)]
        turns, asked = self.run_with({2: merged, 3: three}, 2)
        self.assertEqual((asked, turns), ([2, 3], [turn(0, 5, 0), turn(5, 9, 1)]))

    def test_auto_count_ignores_tiny_clusters(self):
        fragmented = [turn(0, 5, 0), turn(5, 5.1, 1), turn(6, 9, 2), turn(9, 9.1, 3)]
        two = [turn(0, 5, 0), turn(5, 9, 1)]
        turns, asked = self.run_with({None: fragmented, 2: two}, None)
        self.assertEqual((asked, turns), ([None, 2], two))

    def test_auto_count_drops_a_speaker_under_the_final_share(self):
        # 3.5 % of the speech: above the 3 % used to pick the count, below the 4 % an auto result must reach.
        three = [turn(0, 50, 0), turn(50, 96.5, 1), turn(96.5, 100, 2)]
        two = [turn(0, 50, 0), turn(50, 96.5, 1)]
        self.assertEqual(self.run_with({None: three}, None), (two, [None]))
        fragmented = [turn(0, 40, 0), turn(40, 80, 1), turn(80, 100, 2), turn(100, 100.1, 3)]
        self.assertEqual(self.run_with({None: fragmented, 3: three}, None), (two, [None, 3]))

    def test_known_count_keeps_a_small_speaker(self):
        turns = [turn(0, 96.5, 0), turn(96.5, 100, 1)]
        self.assertEqual(self.run_with({2: turns}, 2), (turns, [2]))

    def test_auto_count_keeps_a_result_without_tiny_clusters(self):
        clean = [turn(0, 5, 0), turn(6, 9, 1)]
        self.assertEqual(self.run_with({None: clean}, None), (clean, [None]))
        self.assertEqual(self.run_with({None: []}, None), ([], [None]))

    def test_keep_speakers_keeps_the_longest_and_renumbers(self):
        turns = [turn(0, 1, 0), turn(1, 4, 1), turn(4, 4.5, 2), turn(5, 9, 2)]
        self.assertEqual(diarize.keep_speakers(turns, 2), [turn(1, 4, 0), turn(4, 4.5, 1), turn(5, 9, 1)])
        self.assertEqual(diarize.keep_speakers(turns, 5), turns)


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
