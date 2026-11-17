/* Stand-in for PyAV's libx265-*.dll (the x265 HEVC encoder, GPL). PyAV's FFmpeg build links the libx265 encoder, but
 * the app only decodes audio, so setup-runtime.ps1 puts this DLL in its place under the same file name.
 *
 * avcodec imports only x265_api_get_216 (setup-runtime.ps1 fails the build if it starts importing another symbol).
 * FFmpeg's libx265 wrapper asks for the table of the input's bit depth, falls back to x265_api_get(0) and then calls
 * api->param_alloc() without a NULL check. So every bit depth but 0 gets NULL (FFmpeg then lists no pixel formats for
 * libx265), and 0 gets a table whose functions all return 0: param_alloc() returning NULL makes opening the encoder
 * fail with ENOMEM, and the close path's param_free(NULL) is a no-op. */

static void *none(void) { return 0; }

#define F4 none, none, none, none
#define F32 F4, F4, F4, F4, F4, F4, F4, F4

/* x265_api starts with 8 ints, version_str and build_info_str, then param_alloc and param_free (the only members FFmpeg
 * reaches here); the rest is mostly function pointers, fewer than 128 slots, all filled so any call returns 0. */
static const struct {
    int ints[8];
    const char *version_str, *build_info_str;
    void *(*fn[128])(void);
} api = {{0}, "stub", "stub", {F32, F32, F32, F32}};

__declspec(dllexport) const void *x265_api_get_216(int bit_depth) {
    return bit_depth == 0 ? &api : 0;
}
