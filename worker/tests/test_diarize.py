import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

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


def word(start, end, text):
    return {'start': start, 'end': end, 'text': ' ' + text}


class SplitRowsTests(unittest.TestCase):
    def test_splits_a_row_where_the_speaker_changes(self):
        words = [word(0, 1, 'xin'), word(1, 2, 'chào.'), word(2, 2.5, 'Vâng,'), word(2.5, 3.5, 'cảm'), word(3.5, 4, 'ơn')]
        rows = diarize.split_rows([{'start': 0, 'end': 4, 'text': 'xin chào. Vâng, cảm ơn'}], [words],
                                  [turn(0, 2.1, 0), turn(2.1, 5, 1)])
        self.assertEqual(rows, [{'start': 0, 'end': 2, 'text': 'xin chào.', 'speaker': 0},
                                {'start': 2, 'end': 4, 'text': 'Vâng, cảm ơn', 'speaker': 1}])

    def test_a_single_speaker_row_is_kept_as_it_is(self):
        row = {'start': 0, 'end': 2, 'text': 'xin chào'}
        self.assertEqual(diarize.split_rows([row], [[word(0, 1, 'xin'), word(1, 2, 'chào')]], [turn(0, 9, 1)]),
                         [{**row, 'speaker': 1}])

    def test_a_short_run_joins_its_neighbours(self):
        # One word of speaker 1 between two runs of speaker 0: turn-edge jitter, not a new row.
        words = [word(0, 1, 'a'), word(1, 2, 'b'), word(2, 2.3, 'c'), word(2.3, 3, 'd')]
        row = {'start': 0, 'end': 3, 'text': 'a b c d'}
        self.assertEqual(diarize.split_rows([row], [words], [turn(0, 2, 0), turn(2, 2.3, 1), turn(2.3, 3, 0)]),
                         [{**row, 'speaker': 0}])

    def test_a_short_run_between_two_speakers_joins_the_longer_side(self):
        words = [word(0, 1, 'a'), word(1, 1.2, 'b'), word(1.2, 4, 'c')]
        turns = [turn(0, 1, 0), turn(1, 1.2, 1), turn(1.2, 4, 2)]
        self.assertEqual([(r['text'], r['speaker']) for r in diarize.split_rows([row(0, 4)], [words], turns)],
                         [('a', 0), ('b c', 2)])

    def test_a_row_without_words_takes_the_speaker_of_most_overlap(self):
        self.assertEqual(diarize.split_rows([row(0, 4)], [[]], [turn(0, 1, 0), turn(1, 4, 1)]), [{**row(0, 4), 'speaker': 1}])

    def test_rows_are_never_joined(self):
        rows = diarize.split_rows([row(0, 1), row(1, 2)], [[word(0, 1, 'a')], [word(1, 2, 'b')]], [turn(0, 2, 0)])
        self.assertEqual([(r['start'], r['speaker']) for r in rows], [(0, 0), (1, 0)])


class OverlapTests(unittest.TestCase):
    def test_other_cover_counts_each_second_of_one_speaker_once(self):
        turns = [turn(0, 4, 0), turn(0, 3, 1), turn(2, 4, 1), turn(1, 2, 2)]
        self.assertEqual(diarize.other_cover(row(0, 4), turns, 0), (1, 1.0))  # 1: 3 s + 2 s overlapping by 1 s, 2: 0.25
        self.assertEqual(diarize.other_cover(row(0, 4), turns, 1), (0, 1.0))
        self.assertEqual(diarize.other_cover(row(1, 3), [turn(0, 2, 0), turn(1, 2, 1)], 0), (1, 0.5))

    def test_other_cover_without_another_speaker(self):
        self.assertEqual(diarize.other_cover(row(0, 4), [turn(0, 9, 0), turn(5, 6, 1)], 0), (None, 0.0))
        self.assertEqual(diarize.other_cover(row(0, 4), [], 0), (None, 0.0))

    def test_a_row_talked_over_names_the_other_speaker(self):
        turns = [turn(0, 4, 0), turn(0.1, 3.9, 1)]
        self.assertEqual(diarize.split_rows([row(0, 4)], [[word(0, 2, 'a'), word(2, 4, 'b')]], turns),
                         [{**row(0, 4), 'speaker': 0, 'overlap': 1}])
        self.assertEqual(diarize.split_rows([row(0, 4)], [[]], turns), [{**row(0, 4), 'speaker': 0, 'overlap': 1}])

    def test_a_row_with_only_a_short_interjection_is_not_marked(self):
        turns = [turn(0, 10, 0), turn(1, 1 + 0.3 * 10, 1)]
        (marked,) = diarize.split_rows([row(0, 10)], [[word(0, 10, 'a')]], turns)
        self.assertNotIn('overlap', marked)

    def test_overlap_is_found_per_split_row(self):
        words = [word(0, 2, 'a'), word(2, 4, 'b'), word(4, 6, 'c'), word(6, 8, 'd')]
        turns = [turn(0, 4, 0), turn(4, 8, 1), turn(4.2, 7.8, 2)]
        rows = diarize.split_rows([row(0, 8)], [words], turns)
        self.assertEqual([(r['speaker'], r.get('overlap')) for r in rows], [(0, None), (1, 2)])


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
    def run_with(self, results, count, **limits):
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
                return diarize.diarize(np.zeros(16000, np.float32), Path(tmp), count, **limits), asked
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
        turns, asked = self.run_with({2: one, 3: one, 4: one, None: one}, 2)
        self.assertEqual((asked, turns), ([2, 3, 4, None], one))

    def test_falls_back_to_the_threshold_cut_when_outliers_merge_everyone(self):
        # Every k-cluster cut spends its spare clusters on 1 s outliers; the threshold cut keeps the three speakers.
        merged = [turn(0, 90, 0), turn(90, 91, 1), turn(91, 92, 2)]
        threshold_cut = [turn(0, 30, 0), turn(30, 31, 1), turn(31, 60, 2), turn(60, 90, 3)]
        three = [turn(0, 30, 0), turn(31, 60, 1), turn(60, 90, 2)]
        cuts = {3: merged, 4: merged, 5: merged, None: threshold_cut}
        self.assertEqual(self.run_with(cuts, 3), (three, [3, 4, 5, None]))
        # Auto mode already has the threshold cut, so it costs no extra run.
        self.assertEqual(self.run_with(cuts, None), (three, [None, 3, 4, 5]))

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


class SpeakerRangeTests(unittest.TestCase):
    run_with = KnownSpeakerCountTests.run_with
    three = [turn(0, 3, 0), turn(3, 6, 1), turn(6, 9, 2)]
    two = [turn(0, 4, 0), turn(4, 9, 1)]
    one = [turn(0, 9, 0)]

    def test_an_estimate_inside_the_range_is_kept_without_clustering_again(self):
        turns, asked = self.run_with({None: self.three}, None, min_speakers=2, max_speakers=4)
        self.assertEqual((asked, turns), ([None], self.three))

    def test_an_estimate_above_the_range_is_clustered_again_at_the_maximum(self):
        turns, asked = self.run_with({None: self.three, 2: self.two}, None, max_speakers=2)
        self.assertEqual((asked, turns), ([None, 2], self.two))

    def test_an_estimate_below_the_range_is_clustered_again_at_the_minimum(self):
        turns, asked = self.run_with({None: self.one, 2: self.two}, None, min_speakers=2)
        self.assertEqual((asked, turns), ([None, 2], self.two))

    def test_silence_is_not_clustered_again(self):
        self.assertEqual(self.run_with({None: []}, None, min_speakers=2), ([], [None]))

    def test_rejects_bad_ranges(self):
        for limits, count in (({'min_speakers': 3, 'max_speakers': 2}, None), ({'min_speakers': 0}, None),
                              ({'max_speakers': 0}, None), ({'min_speakers': 1}, 2), ({'max_speakers': 3}, 2)):
            with self.subTest(limits=limits, count=count), self.assertRaises(ValueError):
                self.run_with({}, count, **limits)


class IsolatedTests(unittest.TestCase):
    def fake_models(self, tmp):
        for name in (diarize.SEGMENTATION_FILE, diarize.EMBEDDING_FILE):
            (Path(tmp) / name).parent.mkdir(parents=True, exist_ok=True)
            (Path(tmp) / name).write_bytes(b'')

    def test_a_crashing_child_raises_with_its_exit_code_instead_of_killing_the_caller(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {'THANHAM_DIARIZE_CRASH': '3221225477'}):
            self.fake_models(tmp)
            with self.assertRaisesRegex(RuntimeError, r'exit code 3221225477 \(0xC0000005\)'):
                diarize.diarize_isolated(np.zeros(16000, np.float32), Path(tmp))

    def test_a_child_that_fails_in_python_raises_with_its_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fake_models(tmp)  # empty files are no ONNX models
            with self.assertRaisesRegex(RuntimeError, r'exit code 1 \(0x00000001\)'):
                diarize.diarize_isolated(np.zeros(16000, np.float32), Path(tmp))

    def test_unusable_child_output_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fake_models(tmp)
            for text in (None, 'not json', '[{"start": 0}]', '{"a": 1}'):
                def fake_run(argv, **kwargs):
                    if text is not None:
                        Path(argv[4]).write_text(text, encoding='utf-8')
                    return mock.Mock(returncode=0, stderr=b'')
                with self.subTest(text=text), mock.patch.object(diarize.subprocess, 'run', fake_run), \
                        self.assertRaisesRegex(RuntimeError, 'no usable turns'):
                    diarize.diarize_isolated(np.zeros(16000, np.float32), Path(tmp))

    def test_bad_input_raises_before_a_child_starts(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(diarize.subprocess, 'run', side_effect=AssertionError('started')):
            with self.assertRaises(ValueError):
                diarize.diarize_isolated(np.zeros(0, np.float32), Path(tmp))
            with self.assertRaises(ValueError):
                diarize.diarize_isolated(np.zeros(16000, np.float32), Path(tmp), num_speakers=2, max_speakers=3)
            with self.assertRaises(FileNotFoundError):
                diarize.diarize_isolated(np.zeros(16000, np.float32), Path(tmp))


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

    @unittest.skipUnless(TEST_WAV.is_file(), 'set THANHAM_DIARIZE_TEST_WAV to a mono 16 kHz WAV with alternating speakers')
    def test_isolated_child_gives_the_same_turns_as_in_process(self):
        import soundfile as sf
        audio, _ = sf.read(str(TEST_WAV), dtype='float32')
        for limits in ({}, {'num_speakers': 2}, {'max_speakers': 1}):
            with self.subTest(limits=limits):
                self.assertEqual(diarize.diarize_isolated(audio, MODEL_DIR, **limits), diarize.diarize(audio, MODEL_DIR, **limits))
        self.assertEqual(len({t['speaker'] for t in diarize.diarize(audio, MODEL_DIR, max_speakers=1)}), 1)


if __name__ == '__main__':
    unittest.main()
