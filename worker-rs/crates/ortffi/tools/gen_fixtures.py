"""Records bitwise-comparison fixtures with the app's own Python onnxruntime 1.31.1.

Run with the repo runtime, isolated:
    runtime\\python\\python.exe -I tools\\gen_fixtures.py [--models-root <dir>] [--out fixtures]

For each case it runs the model with the same SessionOptions the app's Python code uses and
saves seeded inputs and the outputs as .npy files named `<run>.in.<name>.npy` and
`<run>.out.<name>.npy`. tests/fixtures.rs replays them through ortffi and demands identical bytes.

Session options being mirrored:
  * Silero VAD: faster_whisper/vad.py `SileroVADModel.__init__`
      inter_op_num_threads=1, intra_op_num_threads=1, enable_cpu_mem_arena=False, log_severity_level=4
  * VieNeu: vieneu/_v3_turbo_engine/onnx_runtime_lite.py (`so`, shared by every session)
      graph_optimization_level=ORT_ENABLE_ALL, inter_op_num_threads=1,
      session.intra_op.allow_spinning=0, intra_op_num_threads=THREADS
"""
import argparse
import hashlib
import os
import sys

import numpy as np
import onnxruntime as ort

THREADS = 8  # vieneu default on the dev machine: min(max(cpu_count // 2, 1), 8) with 16 logical CPUs

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
# crate = <outputs>/wt/rust-ortffi/spikes/ortffi
OUTPUTS = os.path.normpath(os.path.join(CRATE, "..", "..", "..", ".."))
DEFAULT_RUNTIME = os.path.join(OUTPUTS, "thanh-am-studio", "runtime", "python")
DEFAULT_VIENEU = os.path.normpath(os.path.join(OUTPUTS, "..", "work", "tts-gap-guard", "models", "vieneu-v3"))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def silero_options():
    o = ort.SessionOptions()
    o.inter_op_num_threads = 1
    o.intra_op_num_threads = 1
    o.enable_cpu_mem_arena = False
    o.log_severity_level = 4
    return o


def vieneu_options():
    o = ort.SessionOptions()
    o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    o.inter_op_num_threads = 1
    o.add_session_config_entry("session.intra_op.allow_spinning", "0")
    o.intra_op_num_threads = THREADS
    return o


def silero_frames(audio, num_samples=512, context_size_samples=64):
    """Copy of the pre-processing in faster_whisper SileroVADModel.__call__."""
    batched_audio = audio.reshape(-1, num_samples)
    context = batched_audio[..., -context_size_samples:]
    context[-1] = 0
    context = np.roll(context, 1, 0)
    batched_audio = np.concatenate([context, batched_audio], 1)
    return np.ascontiguousarray(batched_audio.reshape(-1, num_samples + context_size_samples))


def speechy_signal(rng, n_samples):
    t = np.arange(n_samples) / 16000.0
    gate = (np.sin(2 * np.pi * 1.3 * t) > -0.2).astype(np.float64)
    voiced = 0.3 * np.sin(2 * np.pi * 140 * t) + 0.15 * np.sin(2 * np.pi * 420 * t) + 0.08 * np.sin(2 * np.pi * 1300 * t)
    noise = 0.02 * rng.standard_normal(n_samples)
    return (gate * voiced + noise).astype(np.float32)


class Recorder:
    def __init__(self, out_dir, case, model_path, options):
        self.dir = os.path.join(out_dir, case)
        os.makedirs(self.dir, exist_ok=True)
        self.session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
        self.case = case

    def run(self, run, feeds):
        out_names = [o.name for o in self.session.get_outputs()]
        outs = self.session.run(out_names, feeds)
        for name, arr in feeds.items():
            np.save(os.path.join(self.dir, f"{run}.in.{name}.npy"), np.ascontiguousarray(arr))
        for name, arr in zip(out_names, outs):
            np.save(os.path.join(self.dir, f"{run}.out.{name}.npy"), np.ascontiguousarray(arr))
        print(f"{self.case}/{run}: " + ", ".join(f"{n}{list(a.shape)}" for n, a in zip(out_names, outs)))
        return dict(zip(out_names, outs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", default=DEFAULT_RUNTIME)
    ap.add_argument("--vieneu", default=DEFAULT_VIENEU)
    ap.add_argument("--out", default=os.path.join(CRATE, "fixtures"))
    args = ap.parse_args()

    assert ort.__version__ == "1.31.1", ort.__version__
    silero = os.path.join(args.runtime, "Lib", "site-packages", "faster_whisper", "assets", "silero_vad_v6.onnx")
    codec = os.path.join(args.vieneu, "codec", "moss_audio_tokenizer_decode_full.onnx")
    step = os.path.join(args.vieneu, "backbone", "onnx_update", "vieneu_decode_step.onnx")
    os.makedirs(args.out, exist_ok=True)

    # Silero VAD v6: f32 in, f32 out, dynamic batch, 576 = 64 context + 512 samples
    rng = np.random.default_rng(20261118)
    zeros = np.zeros((1, 1, 128), dtype=np.float32)
    rec = Recorder(args.out, "silero_batch", silero, silero_options())
    rec.run("full", {"input": silero_frames(speechy_signal(rng, 320 * 512)), "h": zeros, "c": zeros})
    rec.run("noise", {"input": silero_frames((0.1 * rng.standard_normal(64 * 512)).astype(np.float32)), "h": zeros, "c": zeros})

    # Streaming use: the second chunk starts from the first chunk's (h, c)
    rec = Recorder(args.out, "silero_chain", silero, silero_options())
    first = rec.run("s1", {"input": silero_frames(speechy_signal(rng, 100 * 512)), "h": zeros, "c": zeros})
    rec.run("s2", {"input": silero_frames(speechy_signal(rng, 100 * 512)), "h": first["hn"], "c": first["cn"]})

    # VieNeu codec decoder: int32 codes in, f32 audio out (what onnx_runtime_lite's sess_codec_dec runs)
    rng = np.random.default_rng(20261119)
    rec = Recorder(args.out, "vieneu_codec_decode", codec, vieneu_options())
    for run, length in (("l40", 40), ("l7", 7)):
        codes = rng.integers(0, 1024, size=(1, length, 16), dtype=np.int32)
        rec.run(run, {"audio_codes": codes, "audio_code_lengths": np.array([length], dtype=np.int32)})

    # VieNeu backbone decode step: f32 + int64 inputs, 25 outputs (sess_dec)
    rng = np.random.default_rng(20261120)
    rec = Recorder(args.out, "vieneu_decode_step", step, vieneu_options())
    past = 16
    feeds = {
        "inputs_embeds": (0.1 * rng.standard_normal((1, 1, 768))).astype(np.float32),
        "position_ids": np.array([[past]], dtype=np.int64),
    }
    for kind in ("k", "v"):
        for layer in range(12):
            feeds[f"past_{kind}_{layer}"] = (0.2 * rng.standard_normal((1, 4, past, 64))).astype(np.float32)
    rec.run("p16", feeds)

    with open(os.path.join(args.out, "PROVENANCE.txt"), "w", encoding="utf-8") as f:
        f.write(f"python {sys.version.split()[0]}  numpy {np.__version__}  onnxruntime {ort.__version__}\n")
        f.write(f"intra_op_num_threads for VieNeu cases: {THREADS}\n")
        for p in (silero, codec, step):
            f.write(f"{sha256(p)}  {os.path.basename(p)}\n")
        for extra in (
            os.path.join(args.vieneu, "codec", "moss_audio_tokenizer_decode_shared.data"),
            os.path.join(args.vieneu, "backbone", "onnx_update", "vieneu_backbone_shared.data"),
        ):
            f.write(f"{sha256(extra)}  {os.path.basename(extra)}\n")


main()
