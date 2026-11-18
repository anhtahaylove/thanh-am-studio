// C entry over kaldi-native-fbank 1.23.0 (third_party/kaldi-native-fbank, Apache-2.0) with the options of vieneu's
// speaker/audio_utils.py `_kaldi_fbank`: 16 kHz, 25 ms / 10 ms frames, povey window, snip_edges, remove_dc_offset, preemph 0.97,
// dither 0, `n_mels` bins (spike S5: bitwise equal to the Python wheel on 20/20 references).
#include <cstdint>
#include <cstring>

#include "kaldi-native-fbank/csrc/feature-fbank.h"
#include "kaldi-native-fbank/csrc/online-feature.h"

// Writes up to `max_frames` rows of `n_mels` floats to `out`; returns the frame count, or minus it when `out` is too small.
extern "C" int32_t thanham_knf_fbank(const float *wav, int32_t n, int32_t sample_rate, int32_t n_mels, float *out,
                                     int32_t max_frames) {
  knf::FbankOptions opts;
  opts.frame_opts.samp_freq = static_cast<float>(sample_rate);
  opts.frame_opts.frame_shift_ms = 10.0f;
  opts.frame_opts.frame_length_ms = 25.0f;
  opts.frame_opts.dither = 0.0f;
  opts.frame_opts.snip_edges = true;
  opts.frame_opts.window_type = "povey";
  opts.frame_opts.remove_dc_offset = true;
  opts.frame_opts.preemph_coeff = 0.97f;
  opts.mel_opts.num_bins = n_mels;
  knf::OnlineFbank fb(opts);
  fb.AcceptWaveform(static_cast<float>(sample_rate), wav, n);
  fb.InputFinished();
  int32_t frames = fb.NumFramesReady();
  if (frames > max_frames) return -frames;
  for (int32_t i = 0; i < frames; ++i) {
    std::memcpy(out + static_cast<size_t>(i) * n_mels, fb.GetFrame(i), sizeof(float) * n_mels);
  }
  return frames;
}
