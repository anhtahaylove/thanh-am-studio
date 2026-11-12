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
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(model_dir / SEGMENTATION_FILE)),
            num_threads=2, provider='cpu'),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(model_dir / EMBEDDING_FILE), num_threads=2, provider='cpu'),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers or -1, threshold=CLUSTER_THRESHOLD),
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
