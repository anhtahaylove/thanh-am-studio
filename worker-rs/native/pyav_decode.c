// `load_audio(path)` of worker/main.py (faster-whisper 1.2.1's `decode_audio(path, sampling_rate=16000)`, decoding packet by
// packet) as PyAV 18.1.0 runs it, call for call, on the FFmpeg 8.1.2 DLLs that PyAV itself loads (the private runtime's
// `av.libs`, resolved by full path in stt/decode.rs). The same code computes the samples, so the output is bitwise equal to
// Python's (row D at E0).
//
// The Python it mirrors, with every FFmpeg call that bears on the samples, in the same order and with the same arguments:
//   av.open(path)                       Container.__cinit__ (GENPTS, empty options), InputContainer.__cinit__ (find_stream_info,
//                                       a codec context for every stream with a decoder: pkt_timebase, thread_count 0, slice)
//   container.demux(audio=0)            streams.get(audio=0) (IndexError without audio), InputContainer.demux (then one empty
//                                       flush packet); a demuxer error, InvalidDataError included, is raised
//   packet.decode() in a try            CodecContext._decode (open on first use, send, receive until EAGAIN/EOF); an
//                                       InvalidDataError skips that packet and the next one is decoded (SYSTRAN/faster-whisper#1717)
//   a frame's channel count             below the first frame's: ValueError: Frame does not match AudioFifo parameters.
//   _group_frames(frames, 500000)       frame.pts = None; AudioFifo.write; AudioFifo.read() of everything at >= 500000 samples
//                                       and at the end
//   _resample_frames(AudioResampler(format='s16', layout='mono', rate=16000))
//                                       passthrough check on the first frame, else abuffer -> aformat -> abuffersink, push and
//                                       pull until EAGAIN/EOF, then push(None) to flush
//   frame.to_ndarray(), np.frombuffer   the s16 samples of every output frame, in order
// Memory is managed differently from PyAV (frames are reused or freed here); nothing that reaches FFmpeg's computations differs.
// The headers are the unmodified FFmpeg 8.1.2 public headers (third_party/ffmpeg-8.1.2); no FFmpeg function is linked.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>

#define FUNCTIONS                                                                                          \
  F(void, av_log_set_callback, (void (*)(void *, int, const char *, va_list)))                            \
  F(AVFormatContext *, avformat_alloc_context, (void))                                                     \
  F(int, avformat_open_input, (AVFormatContext **, const char *, const AVInputFormat *, AVDictionary **)) \
  F(int, avformat_find_stream_info, (AVFormatContext *, AVDictionary **))                                 \
  F(void, avformat_close_input, (AVFormatContext **))                                                      \
  F(int, av_read_frame, (AVFormatContext *, AVPacket *))                                                   \
  F(const AVCodec *, avcodec_find_decoder, (enum AVCodecID))                                               \
  F(AVCodecContext *, avcodec_alloc_context3, (const AVCodec *))                                           \
  F(int, avcodec_parameters_to_context, (AVCodecContext *, const struct AVCodecParameters *))             \
  F(int, avcodec_open2, (AVCodecContext *, const AVCodec *, AVDictionary **))                              \
  F(int, avcodec_send_packet, (AVCodecContext *, const AVPacket *))                                        \
  F(int, avcodec_receive_frame, (AVCodecContext *, AVFrame *))                                             \
  F(void, avcodec_free_context, (AVCodecContext **))                                                       \
  F(int, avcodec_fill_audio_frame, (AVFrame *, int, enum AVSampleFormat, const uint8_t *, int, int))      \
  F(AVPacket *, av_packet_alloc, (void))                                                                   \
  F(void, av_packet_free, (AVPacket **))                                                                   \
  F(void, av_packet_unref, (AVPacket *))                                                                   \
  F(AVFrame *, av_frame_alloc, (void))                                                                     \
  F(void, av_frame_free, (AVFrame **))                                                                     \
  F(void, av_frame_unref, (AVFrame *))                                                                     \
  F(int, av_frame_copy_props, (AVFrame *, const AVFrame *))                                                \
  F(AVAudioFifo *, av_audio_fifo_alloc, (enum AVSampleFormat, int, int))                                   \
  F(void, av_audio_fifo_free, (AVAudioFifo *))                                                             \
  F(int, av_audio_fifo_write, (AVAudioFifo *, void *const *, int))                                         \
  F(int, av_audio_fifo_read, (AVAudioFifo *, void *const *, int))                                          \
  F(int, av_audio_fifo_size, (AVAudioFifo *))                                                              \
  F(int, av_samples_get_buffer_size, (int *, int, int, enum AVSampleFormat, int))                         \
  F(void *, av_malloc, (size_t))                                                                           \
  F(void, av_free, (void *))                                                                               \
  F(const char *, av_get_sample_fmt_name, (enum AVSampleFormat))                                           \
  F(int, av_channel_layout_describe, (const AVChannelLayout *, char *, size_t))                           \
  F(int, av_channel_layout_from_string, (AVChannelLayout *, const char *))                                 \
  F(int, av_channel_layout_compare, (const AVChannelLayout *, const AVChannelLayout *))                    \
  F(int, av_channel_layout_copy, (AVChannelLayout *, const AVChannelLayout *))                             \
  F(void, av_channel_layout_uninit, (AVChannelLayout *))                                                   \
  F(int, av_dict_set, (AVDictionary **, const char *, const char *, int))                                  \
  F(int, av_dict_count, (const AVDictionary *))                                                            \
  F(void, av_dict_free, (AVDictionary **))                                                                 \
  F(int, av_strerror, (int, char *, size_t))                                                               \
  F(const AVFilter *, avfilter_get_by_name, (const char *))                                                \
  F(AVFilterGraph *, avfilter_graph_alloc, (void))                                                         \
  F(void, avfilter_graph_free, (AVFilterGraph **))                                                         \
  F(AVFilterContext *, avfilter_graph_alloc_filter, (AVFilterGraph *, const AVFilter *, const char *))     \
  F(int, avfilter_init_dict, (AVFilterContext *, AVDictionary **))                                         \
  F(int, avfilter_init_str, (AVFilterContext *, const char *))                                             \
  F(int, avfilter_link, (AVFilterContext *, unsigned, AVFilterContext *, unsigned))                        \
  F(int, avfilter_graph_config, (AVFilterGraph *, void *))                                                 \
  F(int, av_buffersrc_write_frame, (AVFilterContext *, const AVFrame *))                                   \
  F(int, av_buffersink_get_frame, (AVFilterContext *, AVFrame *))

#define F(ret, name, args) ret(*name) args;
static struct {
  FUNCTIONS
} ff;
#undef F

static void no_log(void *avcl, int level, const char *fmt, va_list vl) {
  (void)avcl, (void)level, (void)fmt, (void)vl;
}

// Binds every function through `sym` (a lookup over the loaded DLLs) and installs the log callback `import av` installs (one that
// drops every line, av/logging.py). Returns NULL, or the first name not found. Called once, before any decode.
const char *thanham_av_bind(void *(*sym)(void *ctx, const char *name), void *ctx) {
#define F(ret, name, args) \
  if (!(*(void **)&ff.name = sym(ctx, #name))) return #name;
  FUNCTIONS
#undef F
  ff.av_log_set_callback(no_log);
  return NULL;
}

// What failed, for stt/decode.rs to word as Python does.
enum {
  E_FFMPEG = 1,             // an FFmpeg error code through PyAV's err_check(code, where)
  E_NO_AUDIO = 2,           // IndexError: tuple index out of range (streams.get(audio=0))
  E_FIFO_MISMATCH = 3,      // ValueError: Frame does not match AudioFifo parameters.
  E_RESAMPLER_MISMATCH = 4, // ValueError: Frame does not match AudioResampler setup.
  E_NO_MEMORY = 5,          // MemoryError
  E_RUNTIME = 6,            // RuntimeError(where)
};

typedef struct {
  int kind;
  int code;           // E_FFMPEG: FFmpeg's negative error code
  char where[256];    // err_check's `filename` ("" for none), or the RuntimeError text
  char strerror[64];  // av_strerror(code)
} thanham_av_error;

typedef struct {
  thanham_av_error *err;
  int16_t *out;
  int64_t len, cap;
  // AudioFifo: the first frame's attributes (template) and the PyAV time base it came with
  AVAudioFifo *fifo;
  AVFrame *fifo_template;
  AVRational fifo_tb;
  double pts_per_sample;
  int64_t samples_read;
  // AudioResampler(format='s16', layout='mono', rate=16000): its first input's attributes, and the graph
  AVChannelLayout mono;
  int started, passthrough;
  int rs_format, rs_rate;
  AVChannelLayout rs_layout;
  AVFilterGraph *graph;
  AVFilterContext *src, *sink;
  AVFrame *pulled;
} state;

static int fail(state *st, int kind, int code, const char *where) {
  st->err->kind = kind;
  st->err->code = code;
  snprintf(st->err->where, sizeof st->err->where, "%s", where ? where : "");
  st->err->strerror[0] = 0;
  if (kind == E_FFMPEG) ff.av_strerror(code, st->err->strerror, sizeof st->err->strerror);
  return -1;
}

static int check(state *st, int res, const char *where) {
  return res < 0 ? fail(st, E_FFMPEG, res, where) : 0;
}

// frame.to_ndarray() of an s16 mono frame, appended.
static int collect(state *st, const AVFrame *f) {
  if (st->len + f->nb_samples > st->cap) {
    int64_t cap = st->cap ? st->cap : 1 << 20;
    while (cap < st->len + f->nb_samples) cap *= 2;
    int16_t *grown = realloc(st->out, (size_t)cap * sizeof *grown);
    if (!grown) return fail(st, E_NO_MEMORY, 0, NULL);
    st->out = grown, st->cap = cap;
  }
  memcpy(st->out + st->len, f->extended_data[0], (size_t)f->nb_samples * sizeof *st->out);
  st->len += f->nb_samples;
  return 0;
}

// Graph.add(name, **kwargs): avfilter_graph_alloc_filter, then avfilter_init_dict(kwargs in order), or avfilter_init_str(NULL)
// without kwargs; a kwarg the filter did not take is PyAV's "unused config" ValueError.
static AVFilterContext *add_filter(state *st, const char *name, const char *const *kv) {
  const AVFilter *f = ff.avfilter_get_by_name(name);
  if (!f) return fail(st, E_RUNTIME, 0, name), NULL;
  AVFilterContext *ctx = ff.avfilter_graph_alloc_filter(st->graph, f, name);
  if (!ctx) return fail(st, E_RUNTIME, 0, "Could not allocate AVFilterContext"), NULL;
  if (!kv) return check(st, ff.avfilter_init_str(ctx, NULL), "") ? NULL : ctx;
  AVDictionary *dict = NULL;
  for (; kv[0]; kv += 2) ff.av_dict_set(&dict, kv[0], kv[1], 0);
  int res = ff.avfilter_init_dict(ctx, &dict), unused = ff.av_dict_count(dict);
  ff.av_dict_free(&dict);
  if (check(st, res, "")) return NULL;
  if (unused) return fail(st, E_RUNTIME, 0, "unused config"), NULL;
  return ctx;
}

static int64_t gcd64(int64_t a, int64_t b) {
  a = a < 0 ? -a : a, b = b < 0 ? -b : b;
  while (b) {
    int64_t t = a % b;
    a = b, b = t;
  }
  return a;
}

// AudioResampler.resample(frame); NULL flushes.
static int resample(state *st, const AVFrame *frame) {
  if (!st->graph && !frame) return 0;
  if (st->passthrough) return collect(st, frame);
  if (!st->started) {
    st->started = 1;
    st->rs_format = frame->format, st->rs_rate = frame->sample_rate;
    if (ff.av_channel_layout_copy(&st->rs_layout, &frame->ch_layout) < 0) return fail(st, E_NO_MEMORY, 0, NULL);
    if (frame->format == AV_SAMPLE_FMT_S16 && ff.av_channel_layout_compare(&frame->ch_layout, &st->mono) == 0 &&
        frame->sample_rate == 16000) {
      st->passthrough = 1;
      return collect(st, frame);
    }
    if (!(st->graph = ff.avfilter_graph_alloc())) return fail(st, E_NO_MEMORY, 0, NULL);
    char rate[32], layout[129] = "", tb[64];
    snprintf(rate, sizeof rate, "%d", frame->sample_rate);
    if (ff.av_channel_layout_describe(&frame->ch_layout, layout, sizeof layout) < 0) return fail(st, E_RUNTIME, 0, "Failed to get layout name");
    const char *fmt = ff.av_get_sample_fmt_name(frame->format);
    const char *abuffer[] = {"sample_rate", rate, "sample_fmt", fmt ? fmt : "", "channel_layout", layout, NULL, NULL, NULL};
    if (st->fifo_tb.num && st->fifo_tb.den) {  // frame.time_base is not None: str(Fraction(num, den))
      int64_t g = gcd64(st->fifo_tb.num, st->fifo_tb.den), num, den;
      if (st->fifo_tb.den < 0) g = -g;
      num = st->fifo_tb.num / g, den = st->fifo_tb.den / g;
      if (den == 1) snprintf(tb, sizeof tb, "%lld", (long long)num);
      else snprintf(tb, sizeof tb, "%lld/%lld", (long long)num, (long long)den);
      abuffer[6] = "time_base", abuffer[7] = tb;
    }
    static const char *const aformat[] = {"sample_rates", "16000", "sample_fmts", "s16", "channel_layouts", "mono", NULL};
    AVFilterContext *mid;
    if (!(st->src = add_filter(st, "abuffer", abuffer)) || !(mid = add_filter(st, "aformat", aformat)) ||
        !(st->sink = add_filter(st, "abuffersink", NULL)))
      return -1;
    if (check(st, ff.avfilter_link(st->src, 0, mid, 0), "") || check(st, ff.avfilter_link(mid, 0, st->sink, 0), "") ||
        check(st, ff.avfilter_graph_config(st->graph, NULL), ""))
      return -1;
    if (!(st->pulled = ff.av_frame_alloc())) return fail(st, E_NO_MEMORY, 0, NULL);
  }
  if (frame && (frame->format != st->rs_format || ff.av_channel_layout_compare(&frame->ch_layout, &st->rs_layout) != 0 ||
                frame->sample_rate != st->rs_rate))
    return fail(st, E_RESAMPLER_MISMATCH, 0, NULL);
  if (check(st, ff.av_buffersrc_write_frame(st->src, frame), "")) return -1;
  for (;;) {
    int res = ff.av_buffersink_get_frame(st->sink, st->pulled);
    if (res == AVERROR_EOF || res == AVERROR(EAGAIN)) return 0;
    if (check(st, res, "")) return -1;
    res = collect(st, st->pulled);
    ff.av_frame_unref(st->pulled);
    if (res) return -1;
  }
}

// AudioFifo.read() of every buffered sample into a new frame with the template's attributes, handed to the resampler.
static int fifo_read(state *st) {
  int samples = st->fifo ? ff.av_audio_fifo_size(st->fifo) : 0;
  if (samples < 1) return 0;
  const AVFrame *t = st->fifo_template;
  AVFrame *f = ff.av_frame_alloc();
  if (!f) return fail(st, E_NO_MEMORY, 0, NULL);
  uint8_t *buffer = NULL;
  int res = check(st, ff.av_frame_copy_props(f, t), "");  // _copy_internal_attributes
  if (!res) {
    f->format = t->format, f->width = t->width, f->height = t->height, f->nb_samples = samples;
    if (ff.av_channel_layout_copy(&f->ch_layout, &t->ch_layout) < 0) res = fail(st, E_NO_MEMORY, 0, NULL);
  }
  if (!res && f->ch_layout.nb_channels != 0) {  // AudioFrame._init(format, layout, samples, align=1)
    int size = ff.av_samples_get_buffer_size(NULL, f->ch_layout.nb_channels, samples, f->format, 1);
    if (!(res = check(st, size, ""))) {
      if (!(buffer = ff.av_malloc((size_t)size))) res = fail(st, E_NO_MEMORY, 0, NULL);
      else res = check(st, ff.avcodec_fill_audio_frame(f, f->ch_layout.nb_channels, f->format, buffer, size, 1), "");
    }
  }
  if (!res) res = check(st, ff.av_audio_fifo_read(st->fifo, (void *const *)f->extended_data, samples), "");
  if (!res) {
    f->pts = st->pts_per_sample ? (int64_t)(uint64_t)(st->pts_per_sample * (double)st->samples_read) : AV_NOPTS_VALUE;
    st->samples_read += samples;
    res = resample(st, f);
  }
  ff.av_frame_free(&f);  // frees extended_data when separate, side data and the layout; the samples buffer is ours
  ff.av_free(buffer);
  return res;
}

// `frame.pts = None; fifo.write(frame)`, then `yield fifo.read()` once 500000 samples are buffered (_group_frames).
static int group(state *st, AVFrame *frame, AVRational tb) {
  frame->pts = AV_NOPTS_VALUE;
  if (!frame->nb_samples) return 0;
  if (!st->fifo) {
    AVFrame *t = st->fifo_template = ff.av_frame_alloc();
    if (!t) return fail(st, E_NO_MEMORY, 0, NULL);
    st->fifo_tb = tb;
    if (check(st, ff.av_frame_copy_props(t, frame), "")) return -1;
    t->format = frame->format, t->width = frame->width, t->height = frame->height;
    if (ff.av_channel_layout_copy(&t->ch_layout, &frame->ch_layout) < 0) return fail(st, E_NO_MEMORY, 0, NULL);
    st->pts_per_sample = tb.num && frame->sample_rate ? (double)tb.den / (double)tb.num / frame->sample_rate : 0;
    st->fifo = ff.av_audio_fifo_alloc(frame->format, frame->ch_layout.nb_channels, frame->nb_samples * 2);
    if (!st->fifo) return fail(st, E_RUNTIME, 0, "Could not allocate AVAudioFifo.");
  } else if (frame->format != st->fifo_template->format || frame->sample_rate != st->fifo_template->sample_rate ||
             frame->ch_layout.nb_channels < st->fifo_template->ch_layout.nb_channels ||  // load_audio's own check
             (tb.num && st->fifo_tb.num && (tb.num != st->fifo_tb.num || tb.den != st->fifo_tb.den))) {
    return fail(st, E_FIFO_MISMATCH, 0, NULL);
  }
  if (check(st, ff.av_audio_fifo_write(st->fifo, (void *const *)frame->extended_data, frame->nb_samples), "")) return -1;
  return ff.av_audio_fifo_size(st->fifo) >= 500000 ? fifo_read(st) : 0;
}

// CodecContext.decode(packet), the frames handed on one by one. Returns 1 when it raises InvalidDataError (no frame is handed on).
static int decode(state *st, AVCodecContext *ctx, const AVCodec *codec, int *opened, AVPacket *pkt, AVFrame *frame) {
  if (!codec) return fail(st, E_FFMPEG, AVERROR_DECODER_NOT_FOUND, "");  // Stream._assert_has_codec_context
  if (!*opened) {
    char where[160];
    snprintf(where, sizeof where, "avcodec_open2(\"%s\", {})", codec->name);
    AVDictionary *options = NULL;
    int res = ff.avcodec_open2(ctx, codec, &options);
    ff.av_dict_free(&options);
    if (res == AVERROR_INVALIDDATA) return 1;
    if (check(st, res, where)) return -1;
    *opened = 1;
  }
  int res = ff.avcodec_send_packet(ctx, pkt);
  if (res == AVERROR_INVALIDDATA) return 1;
  if (check(st, res, "avcodec_send_packet()")) return -1;
  for (int count = 0;; count++) {
    res = ff.avcodec_receive_frame(ctx, frame);
    if (res == AVERROR(EAGAIN) || res == AVERROR_EOF) return 0;
    if (res == AVERROR_INVALIDDATA) return count ? 0 : 1;  // with frames already out, PyAV keeps them and stops this packet
    if (check(st, res, "avcodec_receive_frame()")) return -1;
    res = group(st, frame, pkt->time_base);
    ff.av_frame_unref(frame);
    if (res) return -1;
  }
}

// decode_audio(path): 0 with the samples in *out (malloc'd, free with thanham_av_free), or -1 with *err set.
int thanham_av_decode_audio(const char *utf8_path, int16_t **out, int64_t *out_len, thanham_av_error *err) {
  state st = {0};
  st.err = err;
  memset(err, 0, sizeof *err);
  *out = NULL, *out_len = 0;
  AVFormatContext *fmt = NULL;
  AVCodecContext *ctx = NULL;
  AVPacket *pkt = NULL;
  AVFrame *frame = NULL;
  int res = -1, opened = 0;
  if (ff.av_channel_layout_from_string(&st.mono, "mono") != 0) return fail(&st, E_RUNTIME, 0, "Invalid layout: mono");

  // av.open
  if (!(fmt = ff.avformat_alloc_context())) {
    fail(&st, E_NO_MEMORY, 0, NULL);
    goto done;
  }
  fmt->flags |= AVFMT_FLAG_GENPTS;
  AVDictionary *options = NULL;
  int r = ff.avformat_open_input(&fmt, utf8_path, NULL, &options);
  ff.av_dict_free(&options);
  if (check(&st, r, utf8_path)) goto done;  // avformat_open_input freed the context
  if (check(&st, ff.avformat_find_stream_info(fmt, NULL), utf8_path)) goto done;
  int audio = -1;
  const AVCodec *codec = NULL;
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    AVStream *s = fmt->streams[i];
    const AVCodec *c = ff.avcodec_find_decoder(s->codecpar->codec_id);
    if (c) {  // InputContainer.__cinit__ makes a context for every stream with a decoder; parameter errors fail the open
      AVCodecContext *cc = ff.avcodec_alloc_context3(c);
      if (!cc) {
        fail(&st, E_NO_MEMORY, 0, NULL);
        goto done;
      }
      r = ff.avcodec_parameters_to_context(cc, s->codecpar);
      cc->pkt_timebase = s->time_base;
      cc->thread_count = 0;
      cc->thread_type = FF_THREAD_SLICE;
      if (audio < 0 && s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) ctx = cc, codec = c;
      else ff.avcodec_free_context(&cc);
      if (check(&st, r, "")) goto done;
    }
    if (audio < 0 && s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) audio = (int)i;
  }
  if (audio < 0) {
    fail(&st, E_NO_AUDIO, 0, NULL);
    goto done;
  }
  AVRational tb = fmt->streams[audio]->time_base;
  unsigned streams = fmt->nb_streams;
  if (!(pkt = ff.av_packet_alloc()) || !(frame = ff.av_frame_alloc())) {
    fail(&st, E_NO_MEMORY, 0, NULL);
    goto done;
  }
  for (;;) {
    ff.av_packet_unref(pkt);
    r = ff.av_read_frame(fmt, pkt);
    if (r == AVERROR_EOF) break;
    if (check(&st, r, utf8_path)) goto done;  // a demuxer InvalidDataError too: it is raised outside load_audio's try
    if (pkt->stream_index != audio || (unsigned)pkt->stream_index >= streams) continue;
    pkt->time_base = tb;
    if (decode(&st, ctx, codec, &opened, pkt, frame) < 0) goto done;  // 1 (InvalidDataError): skip the packet
  }
  // the flush packet: empty, with the stream's time base
  ff.av_packet_unref(pkt);
  pkt->time_base = tb;
  if (decode(&st, ctx, codec, &opened, pkt, frame) < 0) goto done;
  if (fifo_read(&st) || resample(&st, NULL)) goto done;
  *out = st.out, *out_len = st.len;
  st.out = NULL;
  res = 0;
done:
  free(st.out);
  ff.av_frame_free(&st.pulled);
  ff.avfilter_graph_free(&st.graph);
  ff.av_channel_layout_uninit(&st.rs_layout);
  ff.av_channel_layout_uninit(&st.mono);
  if (st.fifo) ff.av_audio_fifo_free(st.fifo);
  ff.av_frame_free(&st.fifo_template);
  ff.av_frame_free(&frame);
  ff.av_packet_free(&pkt);
  ff.avcodec_free_context(&ctx);
  ff.avformat_close_input(&fmt);
  return res;
}

void thanham_av_free(int16_t *samples) {
  free(samples);
}
