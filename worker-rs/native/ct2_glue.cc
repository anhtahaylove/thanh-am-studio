// C++ glue for the statically linked CTranslate2 engine (feature `ct2`, worker-rs/engine/build-engine.ps1).
#include <intrin.h>
#include <stdlib.h>
#include <string.h>

#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

#include <ctranslate2/models/whisper.h>
#include <ctranslate2/storage_view.h>
#include <ctranslate2/types.h>

namespace ctranslate2 {
  namespace cpu {
    // As declared in CTranslate2 4.8.5 src/cpu/backend.h, which the install does not ship.
    enum class GemmBackend { NONE, MKL, DNNL, ACCELERATE, OPENBLAS, RUY };
    std::string gemm_backend_to_str(GemmBackend gemm_backend);
    GemmBackend get_gemm_backend(ComputeType compute_type);
  }
}

// The GEMM backend CTranslate2 uses for int8 (the worker's compute type), as `health` reports it: "MKL" or "DNNL".
extern "C" std::size_t thanham_ct2_gemm_int8(char* dst, std::size_t cap) {
  const std::string name = ctranslate2::cpu::gemm_backend_to_str(ctranslate2::cpu::get_gemm_backend(ctranslate2::ComputeType::INT8));
  if (dst && cap > name.size()) memcpy(dst, name.c_str(), name.size() + 1);
  return name.size();
}

// Copies a ctranslate2::StorageView (ct2rs-sys exposes only its shape) to float32.
extern "C" std::size_t thanham_sv_copy_f32(const void* sv, float* dst, std::size_t cap) {
  const auto* s = static_cast<const ctranslate2::StorageView*>(sv);
  const ctranslate2::StorageView f = s->dtype() == ctranslate2::DataType::FLOAT32 ? *s : s->to_float32();
  const std::size_t n = static_cast<std::size_t>(f.size());
  if (dst && n <= cap) memcpy(dst, f.data<float>(), n * sizeof(float));
  return n;
}

// The Whisper calls faster-whisper 1.2.1 makes, through the C++ API the way the wheel's Python binding (python/cpp/whisper.cc and
// replica_pool.h of CTranslate2 4.8.5) makes them. Exceptions stop here: `error` gets the Python class pybind11 would raise and the
// message, and the call returns -1 (or null).
struct thanham_ct2_error {
  char kind[32];
  char message[1024];
};

namespace {
  using ctranslate2::StorageView;
  using ctranslate2::models::Whisper;

  void copy_text(char* dst, std::size_t cap, const char* text) {
    std::size_t n = strlen(text);
    if (n >= cap) n = cap - 1;
    memcpy(dst, text, n);
    dst[n] = 0;
  }

  void set_error(thanham_ct2_error* error, const char* kind, const char* message) {
    copy_text(error->kind, sizeof error->kind, kind);
    copy_text(error->message, sizeof error->message, message);
  }

  // pybind11's translation of the standard exceptions.
  template <typename F>
  int guarded(thanham_ct2_error* error, F&& body) {
    try {
      body();
      return 0;
    } catch (const std::bad_alloc& e) {
      set_error(error, "MemoryError", e.what());
    } catch (const std::out_of_range& e) {
      set_error(error, "IndexError", e.what());
    } catch (const std::overflow_error& e) {
      set_error(error, "OverflowError", e.what());
    } catch (const std::invalid_argument& e) {
      set_error(error, "ValueError", e.what());
    } catch (const std::length_error& e) {
      set_error(error, "ValueError", e.what());
    } catch (const std::domain_error& e) {
      set_error(error, "ValueError", e.what());
    } catch (const std::range_error& e) {
      set_error(error, "ValueError", e.what());
    } catch (const std::exception& e) {
      set_error(error, "RuntimeError", e.what());
    } catch (...) {
      set_error(error, "RuntimeError", "Caught an unknown exception!");
    }
    return -1;
  }
}

// `ctranslate2.models.Whisper(model_dir, device='cpu', device_index=0, compute_type='int8', intra_threads=threads,
// inter_threads=1)`, as faster-whisper's WhisperModel(..., cpu_threads=threads, num_workers=1) creates it.
extern "C" void* thanham_whisper_load(const char* model_dir, std::size_t threads, thanham_ct2_error* error) {
  Whisper* whisper = nullptr;
  guarded(error, [&] {
    ctranslate2::models::ModelLoader loader(std::make_shared<ctranslate2::models::ModelFileReader>(model_dir));
    loader.device = ctranslate2::Device::CPU;
    loader.device_indices = {0};
    loader.compute_type = ctranslate2::ComputeType::INT8;
    loader.num_replicas_per_device = 1;
    ctranslate2::ReplicaPoolConfig config;
    config.num_threads_per_replica = threads;
    config.max_queued_batches = 0;
    whisper = new Whisper(loader, config);
  });
  return whisper;
}

extern "C" void thanham_whisper_free(void* whisper) {
  delete static_cast<Whisper*>(whisper);
}

// `model.encode(features, to_cpu=False)` on a float32 `[1, n_mels, frames]` buffer, which the input view does not copy (nor does
// `StorageView.from_array`). The result is a new StorageView for thanham_sv_free.
extern "C" void* thanham_whisper_encode(void* whisper, const float* features, std::size_t n_mels, std::size_t frames,
                                        thanham_ct2_error* error) {
  StorageView* out = nullptr;
  guarded(error, [&] {
    const StorageView input({1, static_cast<ctranslate2::dim_t>(n_mels), static_cast<ctranslate2::dim_t>(frames)},
                            const_cast<float*>(features));
    out = new StorageView(static_cast<Whisper*>(whisper)->encode(input, false).get());
  });
  return out;
}

extern "C" void thanham_sv_free(void* sv) {
  delete static_cast<StorageView*>(sv);
}

// WhisperOptions as the binding fills them from `generate`'s arguments.
struct thanham_whisper_options {
  std::size_t beam_size;
  float patience;
  std::size_t num_hypotheses;
  float length_penalty;
  float repetition_penalty;
  std::size_t no_repeat_ngram_size;
  std::size_t max_length;
  std::size_t max_initial_timestamp_index;
  int suppress_blank;
  const int* suppress_tokens;
  std::size_t suppress_tokens_len;
  std::size_t sampling_topk;
  float sampling_temperature;
};

// `model.generate(features, [prompt], return_scores=True, return_no_speech_prob=True, ...)[0]`: `sequence` gets each hypothesis
// (its ids and score) in order.
extern "C" int thanham_whisper_generate(void* whisper, const void* features, const std::size_t* prompt, std::size_t prompt_len,
                                        const thanham_whisper_options* o, float* no_speech_prob, void* ctx,
                                        void (*sequence)(void*, const std::size_t*, std::size_t, float),
                                        thanham_ct2_error* error) {
  return guarded(error, [&] {
    ctranslate2::models::WhisperOptions options;
    options.beam_size = o->beam_size;
    options.patience = o->patience;
    options.length_penalty = o->length_penalty;
    options.repetition_penalty = o->repetition_penalty;
    options.no_repeat_ngram_size = o->no_repeat_ngram_size;
    options.sampling_topk = o->sampling_topk;
    options.sampling_temperature = o->sampling_temperature;
    options.max_length = o->max_length;
    options.num_hypotheses = o->num_hypotheses;
    options.return_scores = true;
    options.return_logits_vocab = false;
    options.return_no_speech_prob = true;
    options.max_initial_timestamp_index = o->max_initial_timestamp_index;
    options.suppress_blank = o->suppress_blank != 0;
    options.suppress_tokens.assign(o->suppress_tokens, o->suppress_tokens + o->suppress_tokens_len);
    std::vector<std::vector<std::size_t>> prompts{std::vector<std::size_t>(prompt, prompt + prompt_len)};
    auto futures = static_cast<Whisper*>(whisper)->generate(*static_cast<const StorageView*>(features), prompts, options);
    const auto result = futures.at(0).get();
    for (std::size_t i = 0; i < result.sequences_ids.size(); ++i) {
      const auto& ids = result.sequences_ids[i];
      sequence(ctx, ids.data(), ids.size(), i < result.scores.size() ? result.scores[i] : 0.0f);
    }
    *no_speech_prob = result.no_speech_prob;
  });
}

// `model.align(features, start_sequence, text_tokens, num_frames, median_filter_width)`: one result per text, as its (text index,
// time index) pairs (the worker does not use the word probabilities). `tokens` holds the texts one after the other, `token_lens` their lengths.
extern "C" int thanham_whisper_align(void* whisper, const void* features, const std::size_t* start, std::size_t start_len,
                                     const std::size_t* tokens, const std::size_t* token_lens, std::size_t texts,
                                     std::size_t num_frames, std::size_t median_filter_width, void* ctx,
                                     void (*alignment)(void*, const std::int64_t*, std::size_t),
                                     thanham_ct2_error* error) {
  return guarded(error, [&] {
    std::vector<std::vector<std::size_t>> text_tokens;
    for (std::size_t i = 0, at = 0; i < texts; at += token_lens[i], ++i)
      text_tokens.emplace_back(tokens + at, tokens + at + token_lens[i]);
    auto futures = static_cast<Whisper*>(whisper)->align(*static_cast<const StorageView*>(features),
                                                         std::vector<std::size_t>(start, start + start_len),
                                                         std::move(text_tokens), std::vector<std::size_t>(texts, num_frames),
                                                         static_cast<ctranslate2::dim_t>(median_filter_width));
    for (auto& future : futures) {
      const auto result = future.get();
      std::vector<std::int64_t> pairs;
      for (const auto& p : result.alignments) {
        pairs.push_back(p.first);
        pairs.push_back(p.second);
      }
      alignment(ctx, pairs.data(), result.alignments.size());
    }
  });
}

// `model.detect_language(features)[0]`: each (language token, probability), most probable first.
extern "C" int thanham_whisper_detect_language(void* whisper, const void* features, void* ctx,
                                               void (*language)(void*, const char*, float), thanham_ct2_error* error) {
  return guarded(error, [&] {
    auto futures = static_cast<Whisper*>(whisper)->detect_language(*static_cast<const StorageView*>(features));
    for (const auto& [token, probability] : futures.at(0).get()) language(ctx, token.c_str(), probability);
  });
}

// CTranslate2 caches `mayiuse_mkl()` ("CT2_USE_MKL", else "the CPU is GenuineIntel") the first time anything asks. In this static
// executable something asks during C++ static initialization, before cpu_features has filled its CPU info, so the cached answer
// is false and CT2 silently runs on oneDNN instead of MKL (spike S1: the encoder then differs from the wheel's; with MKL it is
// bitwise equal). A CRT initializer in .CRT$XCT runs before every .CRT$XCU (C++ dynamic initializer) and makes the choice first,
// with the wheel's own rule: GenuineIntel only, so other CPUs keep the oneDNN path as with the wheel. A user's own CT2_USE_MKL
// is left alone.
#pragma section(".CRT$XCT", read)
extern "C" void __cdecl thanham_early_ct2_env() {
  int r[4];
  __cpuid(r, 0);
  char vendor[13];
  memcpy(vendor, &r[1], 4);
  memcpy(vendor + 4, &r[3], 4);
  memcpy(vendor + 8, &r[2], 4);
  vendor[12] = 0;
  if (strcmp(vendor, "GenuineIntel") != 0) return;
  char* v = nullptr;
  size_t n = 0;
  if (_dupenv_s(&v, &n, "CT2_USE_MKL") != 0 || v == nullptr) _putenv_s("CT2_USE_MKL", "1");
  free(v);
}
extern "C" __declspec(allocate(".CRT$XCT")) void(__cdecl* thanham_early_ct2_env_p)() = thanham_early_ct2_env;
#pragma comment(linker, "/include:thanham_early_ct2_env_p")
