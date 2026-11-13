"""Offline speaker diarization for the STT pipeline.

pyannote segmentation-3.0 (ONNX, MIT) finds who speaks when; a 3D-Speaker CAM++
embedding (ONNX, Apache-2.0) is clustered into speakers. Both run through sherpa-onnx
on CPU, fully from files in ``model_dir`` (see the ``diarization`` entry of models.json).
"""
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
SEGMENTATION_FILE = 'segmentation/model.onnx'
EMBEDDING_FILE = 'embedding/model.onnx'
# Cosine-distance cut when the speaker count is unknown. sherpa's default 0.5 split 2-3 TTS voices into 4 under
# noise; 0.65 and 0.8 both found the right count on all four synthetic mixes. Tuned on little data: re-check on real recordings.
CLUSTER_THRESHOLD = 0.65
# A cluster with less of the speech than this is an outlier (laughter, crosstalk, noise), not a speaker. On 30-50 minute
# four-person meetings (AMI) the threshold alone gave 41-138 clusters, most of them tiny.
MIN_SPEAKER_SHARE = 0.03
# Auto mode only: the finished result keeps speakers with at least this share. The count above is taken on the first,
# often fragmented clustering; once re-clustered, real AMI speakers hold 10-40 % and leftover clusters 0.3-5 %.
MIN_AUTO_SHARE = 0.04
# A row splits where its words change speaker, but a run of words shorter than this joins a neighbour: word times and
# turn edges are only accurate to a few hundred ms. On four Vietnamese talk shows 0.6 s agreed best with two reference
# diarizers (0, 0.3, 1, 1.5 and 2 s tried); 0 and 0.3 s split off 3-5x as many rows for less agreement.
MIN_RUN_S = 0.6


def diarize(audio_16k: np.ndarray, model_dir: Path, num_speakers: int | None = None) -> list[dict]:
    """Return speaker turns [{'start': s, 'end': s, 'speaker': 0..n-1}] sorted by start time.

    Speakers are numbered by first appearance. Turns from different speakers may overlap.
    num_speakers=None estimates the speaker count from the audio.
    """
    audio = np.asarray(audio_16k, dtype=np.float32)
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
        raise ValueError('audio_16k must be a non-empty finite mono float array')
    if num_speakers is not None and num_speakers < 1:
        raise ValueError('num_speakers must be at least 1')
    model_dir = Path(model_dir)
    for name in (SEGMENTATION_FILE, EMBEDDING_FILE):
        if not (model_dir / name).is_file():
            raise FileNotFoundError(f'Diarization model file missing: {model_dir / name}')
    auto = num_speakers is None
    threshold_cut = None
    if auto:
        threshold_cut = _turns(audio, model_dir, None)
        num_speakers = max(1, real_speakers(threshold_cut))
        if not threshold_cut or num_speakers == len({t['speaker'] for t in threshold_cut}):
            return drop_small_speakers(threshold_cut)
        # Outlier clusters found: cluster again into the speakers that are left.
    # Complete-linkage clustering cut at k clusters can spend a cluster on an outlier embedding with little or
    # no speech of its own, merging two real speakers (17 of 97 real two-speaker dialogues lost one).
    # Ask for up to two more clusters until k real speakers appear, then keep the k who speak most.
    for extra in range(3):
        turns = _turns(audio, model_dir, num_speakers + extra)
        if real_speakers(turns) >= num_speakers:
            break
    else:
        if real_speakers(turns) == 1:
            # Outliers took every spare cluster and everyone merged into one speaker (a TV talk show with jingles:
            # 3 guests -> 1). The threshold cut keeps outliers apart, so take it if it holds more real speakers.
            # Only on this collapse: when 2+ speakers are left, the threshold cut was the worse one on AMI/ViYT/VIVOS.
            if threshold_cut is None:
                threshold_cut = _turns(audio, model_dir, None)
            if real_speakers(threshold_cut) > 1:
                turns = threshold_cut
    turns = keep_speakers(turns, num_speakers)
    return drop_small_speakers(turns) if auto else turns


def speech_seconds(turns: list[dict]) -> dict[int, float]:
    total = {}
    for turn in turns:
        total[turn['speaker']] = total.get(turn['speaker'], 0.0) + turn['end'] - turn['start']
    return total


def real_speakers(turns: list[dict], share: float = MIN_SPEAKER_SHARE) -> int:
    """Count the speakers with at least `share` of the speech."""
    total = speech_seconds(turns)
    return sum(seconds >= share * sum(total.values()) for seconds in total.values())


def drop_small_speakers(turns: list[dict]) -> list[dict]:
    """Keep the speakers with at least MIN_AUTO_SHARE of the speech, and always at least one."""
    return keep_speakers(turns, max(1, real_speakers(turns, MIN_AUTO_SHARE)))


def keep_speakers(turns: list[dict], count: int) -> list[dict]:
    """Keep the turns of the `count` speakers with the most speech, renumbered by first appearance."""
    total = speech_seconds(turns)
    kept = set(sorted(total, key=lambda s: (-total[s], s))[:count])
    order = {}
    return [{**turn, 'speaker': order.setdefault(turn['speaker'], len(order))} for turn in turns if turn['speaker'] in kept]


def _turns(audio: np.ndarray, model_dir: Path, num_clusters: int | None) -> list[dict]:
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(model_dir / SEGMENTATION_FILE)),
            num_threads=2, provider='cpu'),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(model_dir / EMBEDDING_FILE), num_threads=2, provider='cpu'),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_clusters or -1, threshold=CLUSTER_THRESHOLD),
        min_duration_on=0.3, min_duration_off=0.5)
    engine = sherpa_onnx.OfflineSpeakerDiarization(config)
    if engine.sample_rate != SAMPLE_RATE:
        raise RuntimeError(f'Unexpected diarization sample rate {engine.sample_rate}')
    turns = sorted(({'start': float(r.start), 'end': float(r.end), 'speaker': int(r.speaker)}
                    for r in engine.process(audio).sort_by_start_time()), key=lambda t: (t['start'], t['end']))
    order = {}
    for turn in turns:
        turn['speaker'] = order.setdefault(turn['speaker'], len(order))
    return turns


def assign_speakers(transcript_rows: list[dict], turns: list[dict]) -> list[int]:
    """Label each row ({'start', 'end'} seconds) with the speaker of largest time overlap.

    A row no turn overlaps takes the speaker of the nearest turn (by time gap); with no turns, 0.
    """
    labels = []
    for row in transcript_rows:
        overlap = {}
        for turn in turns:
            shared = min(row['end'], turn['end']) - max(row['start'], turn['start'])
            if shared > 0:
                overlap[turn['speaker']] = overlap.get(turn['speaker'], 0.0) + shared
        if overlap:
            labels.append(max(overlap, key=lambda s: (overlap[s], -s)))
        elif turns:
            gap = lambda t: max(t['start'] - row['end'], row['start'] - t['end'])
            labels.append(min(turns, key=gap)['speaker'])
        else:
            labels.append(0)
    return labels


def split_rows(rows: list[dict], words: list[list[dict]], turns: list[dict]) -> list[dict]:
    """Give each row a speaker, splitting a row into several where its words change speaker.

    words[i] lists row i's words [{'start', 'end', 'text'}], each text with its own leading space. Every word takes a
    speaker as assign_speakers() does; a run of words shorter than MIN_RUN_S joins its longer neighbour run.
    A row with a single run, or without words, keeps its start, end and text.
    """
    out = []
    for row, row_words in zip(rows, words):
        if not row_words:
            out.append({**row, 'speaker': assign_speakers([row], turns)[0]})
            continue
        runs = _join_runs(zip(assign_speakers(row_words, turns), ([word] for word in row_words)))
        while len(runs) > 1:
            span = [run[1][-1]['end'] - run[1][0]['start'] for run in runs]
            i = min(range(len(runs)), key=span.__getitem__)
            if span[i] >= MIN_RUN_S:
                break
            j = i - 1 if i == len(runs) - 1 or (i > 0 and span[i - 1] >= span[i + 1]) else i + 1
            runs[i][0] = runs[j][0]
            runs = _join_runs(runs)
        if len(runs) == 1:
            out.append({**row, 'speaker': runs[0][0]})
        else:
            out += [{'start': run[0]['start'], 'end': run[-1]['end'], 'text': ''.join(w['text'] for w in run).strip(),
                     'speaker': speaker} for speaker, run in runs]
    return out


def _join_runs(pairs) -> list[list]:
    """Join consecutive (speaker, words) pairs of the same speaker into [speaker, words] runs."""
    runs = []
    for speaker, words in pairs:
        if runs and runs[-1][0] == speaker:
            runs[-1][1] += words
        else:
            runs.append([speaker, list(words)])
    return runs
