/* Stand-in for PyAV's libx264-165-*.dll (the x264 H.264 encoder, GPL). PyAV's FFmpeg build links the libx264 encoder,
 * but the app only decodes audio, so setup-runtime.ps1 puts this DLL in its place under the same file name.
 *
 * It exports every symbol avcodec imports from x264 (setup-runtime.ps1 fails the build if avcodec starts importing
 * another one) and contains no encoder: int functions return -1, x264_encoder_open returns NULL and void functions do
 * nothing. FFmpeg's X264_init calls x264_param_default and then x264_param_default_preset, so opening the libx264
 * encoder fails there with EINVAL ("Error setting preset/tune") instead of encoding. */

#define STUB_INT(name) __declspec(dllexport) int name(void) { return -1; }
#define STUB_VOID(name) __declspec(dllexport) void name(void) {}

STUB_INT(x264_encoder_delayed_frames)
STUB_INT(x264_encoder_encode)
STUB_INT(x264_encoder_headers)
STUB_INT(x264_encoder_maximum_delayed_frames)
STUB_INT(x264_encoder_reconfig)
STUB_INT(x264_param_apply_profile)
STUB_INT(x264_param_default_preset)
STUB_INT(x264_param_parse)
STUB_VOID(x264_encoder_close)
STUB_VOID(x264_param_apply_fastfirstpass)
STUB_VOID(x264_param_cleanup)
STUB_VOID(x264_param_default)
STUB_VOID(x264_picture_init)
__declspec(dllexport) void *x264_encoder_open_165(void) { return 0; }

/* x264_level_t[] (28-byte entries) ends at the first entry whose level_idc is 0, so all zeros is an empty table. */
__declspec(dllexport) const unsigned char x264_levels[4096] = {0};
