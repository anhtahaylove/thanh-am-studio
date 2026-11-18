"""The Python clone-conditioning path of Thanh Am Studio 1.0.16, run through the real functions with taps.

Path (worker/main.py tts() -> clone_reference, then VieNeu V3TurboVieNeuTTS.infer -> _enroll_reference):
  1. clone_reference: soundfile.read(float32, 2-D) -> channel mean -> clone_window (busiest 8 s) -> crop WAV (FLOAT)  [skipped when <= 8 s]
  2. _preclean_reference_audio: soundfile.read -> channel mean -> librosa.effects.trim(top_db=30) -> soundfile.write (default PCM_16)
  3. engine.prepare_reference: _load_mono (soundfile.read, channel mean) -> cap 8 s ->
       denoiser: soxr -> 44.1 kHz, peak-normalise, numpy STFT (f64), ORT, numpy iSTFT -> 44.1 kHz f32
       speaker encoder: soxr -> 16 kHz, kaldi-native-fbank 80 bins, mean norm, ORT -> 192-d embedding
       codec encoder: soxr -> 48 kHz, zero-pad to 3840-sample frames, stereo, ORT -> codes (T, 16)
Nothing here changes behaviour: every step is the installed function; the taps only copy inputs and outputs.
"""
import contextlib
import os
import tempfile
from pathlib import Path

import numpy as np

from s5common import patched


class _Tap:
    def __init__(self):
        self.soxr = []       # (in_rate, out_rate, quality, input, output)
        self.core = []       # denoiser ORT: (mag, cos, sin) float32 inputs and the three outputs
        self.knf_in = []     # wav handed to kaldi-native-fbank
        self.knf_out = []    # raw fbank features (T, 80) before mean normalisation
        self.codec = []      # (stereo input, lengths, raw ORT codes)
        self.istft_in = []   # complex spectrum given to the numpy iSTFT


class _CodecProxy:
    def __init__(self, session, tap):
        self._session, self._tap = session, tap

    def run(self, names, feed):
        out = self._session.run(names, feed)
        self._tap.codec.append((feed['waveform'].copy(), feed['input_lengths'].copy(), np.asarray(out[0]).copy()))
        return out

    def __getattr__(self, name):
        return getattr(self._session, name)


def istft_f64(spec, out_len):
    """Variant: the installed _istft with irfft computed in float64 (numpy < 2 behaviour) instead of float32."""
    from vieneu._v3_turbo_engine import onnx_denoiser as od
    spec = np.concatenate([spec, spec[:, -1:]], axis=1).astype(np.complex128)
    frames = np.fft.irfft(spec, n=od.N_FFT, axis=0) * od._WIN[:, None]
    T = spec.shape[1]
    siglen = od.N_FFT + od.HOP * (T - 1)
    out = np.zeros(siglen)
    wsum = np.zeros(siglen)
    w2 = od._WIN ** 2
    for i in range(T):
        s = i * od.HOP
        out[s:s + od.N_FFT] += frames[:, i]
        wsum[s:s + od.N_FFT] += w2
    out = out / np.maximum(wsum, 1e-11)
    pad = od.N_FFT // 2
    out = out[pad:siglen - pad]
    if len(out) < out_len:
        out = np.pad(out, (0, out_len - len(out)))
    return out[:out_len]


def run_pipeline(worker, engine, ref_path, soxr_quality='HQ', irfft64=False, verify=True):
    """Run the clone-conditioning path on `ref_path`. Returns a dict of every intermediate plus 'emb' and 'codes'.
    With verify=True the result is checked bitwise against V3TurboVieNeuTTS._enroll_reference on the same crop."""
    import soundfile as sf
    import soxr as soxr_mod
    import librosa
    from vieneu.v3turbo import V3TurboVieNeuTTS
    from vieneu._v3_turbo_engine import onnx_denoiser as od
    from vieneu._v3_turbo_engine.speaker import audio_utils as au
    from vieneu._v3_turbo_engine.onnx_runtime_lite import _MAX_REF_SECONDS

    eng = engine.engine
    tap = _Tap()
    st = {}
    ref_path = str(ref_path)

    # 1. clone_reference, split into its parts so the window and the crop are recorded
    audio, sr0 = sf.read(ref_path, dtype='float32', always_2d=True)
    start, end = worker.clone_window(audio.mean(axis=1), sr0)
    st['decoded'], st['sr0'], st['window'] = audio, sr0, (int(start), int(end))
    crop_path = worker.clone_reference(ref_path)
    try:
        cropped = audio if crop_path == ref_path else audio[start:end]
        crop_back, _ = sf.read(crop_path, dtype='float32', always_2d=True)
        assert np.array_equal(crop_back, cropped), 'crop file differs from audio[start:end]'
        st['crop'] = cropped

        # 2. _preclean_reference_audio, replicated step by step and checked against the real file
        fd, clean_path = tempfile.mkstemp(prefix='s5-clean-', suffix='.wav')
        os.close(fd)
        try:
            V3TurboVieNeuTTS._preclean_reference_audio(crop_path, out_path=clean_path)
            wav, sr = sf.read(crop_path, dtype='float32', always_2d=False)
            if wav.ndim > 1:
                wav = wav.mean(axis=1)
            wav = np.asarray(wav, dtype=np.float32)
            trimmed, idx = librosa.effects.trim(wav, top_db=30)
            st['trim_in'], st['trim_idx'], st['trimmed'] = wav, (int(idx[0]), int(idx[1])), np.asarray(trimmed, dtype=np.float32)
            fd2, replica = tempfile.mkstemp(prefix='s5-replica-', suffix='.wav')
            os.close(fd2)
            try:
                sf.write(replica, trimmed, sr)
                assert Path(replica).read_bytes() == Path(clean_path).read_bytes(), 'replicated preclean differs from the real one'
            finally:
                Path(replica).unlink(missing_ok=True)
            pcm16, _ = sf.read(clean_path, dtype='float32', always_2d=True)
            st['pcm16'] = pcm16.mean(axis=1)
            st['sr_clean'] = int(sr)

            # 3. prepare_reference under the taps
            def tap_soxr(x, in_rate, out_rate, quality=None):
                q = soxr_quality if quality is None else quality
                out = soxr_mod_resample(x, in_rate, out_rate, quality=q)
                tap.soxr.append((int(in_rate), int(out_rate), q, np.asarray(x).copy(), np.asarray(out).copy()))
                return out

            real_core = od.OnnxDenoiser._core

            def tap_core(self, mag, cos, sin):
                o = real_core(self, mag, cos, sin)
                tap.core.append((mag.astype(np.float32), cos.astype(np.float32), sin.astype(np.float32),
                                 np.asarray(o[0]).copy(), np.asarray(o[1]).copy(), np.asarray(o[2]).copy()))
                return o

            real_istft = istft_f64 if irfft64 else od._istft

            def tap_istft(spec, out_len):
                tap.istft_in.append(np.asarray(spec).copy())
                return real_istft(spec, out_len)

            real_knf = au._kaldi_fbank

            def tap_knf(wav, sample_rate, n_mels, dither):
                out = real_knf(wav, sample_rate, n_mels, dither)
                tap.knf_in.append(np.asarray(wav).copy())
                tap.knf_out.append(out.copy())
                return out

            if eng._sess_codec_enc is None:
                eng._encode_ref_wav(np.zeros(48000, np.float32), 48000)  # creates the lazy codec-encoder session
            real_sess = eng._sess_codec_enc
            if isinstance(real_sess, _CodecProxy):
                real_sess = real_sess._session
            soxr_mod_resample = soxr_mod.resample
            eng._ensure_speaker_encoder()
            with contextlib.ExitStack() as stack:
                stack.enter_context(patched(soxr_mod, 'resample', tap_soxr))
                stack.enter_context(patched(od.OnnxDenoiser, '_core', tap_core))
                stack.enter_context(patched(od, '_istft', tap_istft))
                stack.enter_context(patched(au, '_kaldi_fbank', tap_knf))
                eng._sess_codec_enc = _CodecProxy(real_sess, tap)
                try:
                    emb, codes = eng.prepare_reference(clean_path, denoise=True, use_ref_codes=True)
                finally:
                    eng._sess_codec_enc = real_sess
            st['emb'], st['codes'] = np.asarray(emb, dtype=np.float32), np.asarray(codes, dtype=np.int64)

            if verify and soxr_quality == 'HQ' and not irfft64:
                engine._ref_cache.clear()
                emb2, codes2 = engine._enroll_reference(crop_path, denoise=True, use_ref_codes=True)
                engine._ref_cache.clear()
                assert np.array_equal(emb2, st['emb']) and np.array_equal(codes2, st['codes']), 'recorder differs from _enroll_reference'
        finally:
            Path(clean_path).unlink(missing_ok=True)
    finally:
        if crop_path != ref_path:
            Path(crop_path).unlink(missing_ok=True)

    st['tap'] = tap
    return st
