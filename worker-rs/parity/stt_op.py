r"""stt_op.py: rows T4 (STT performance) and T5 (STT robustness). The Python worker and the Rust worker run the same `stt` request on
this machine, one process each, interleaved (Python first) for --rounds rounds. Each process's wall time, peak working set, CPU time,
the machine's available memory and CPU % around it, and the cores other processes used meanwhile go to <out>/ram.csv (tts_op.py's
columns), and every round compares the two runs' events (progress and result: rows, speakers, language). An item whose decoding fell
back to a sampling temperature is unseeded on both sides, so such a difference is reported here and judged by rows T1b/T2.

usage: python -I stt_op.py --python <runtime python.exe> --exe <staged thanham-worker.exe> --model <Whisper folder> --input <audio>
                           --out <dir> [--rounds 1] [--language vi|auto] [--speakers N --diarize-model <folder>]

Both workers run at BelowNormal, opted out of EcoQoS, and inherit this script's affinity: pin it to one core type
(`start /affinity FFF`). Exits 1 on a difference or a failed run."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tts_op import HERE, run  # noqa: E402  (-I leaves this folder off sys.path)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    for a in ('--python', '--exe', '--model', '--input', '--out'):
        ap.add_argument(a, required=True)
    ap.add_argument('--rounds', type=int, default=1)
    ap.add_argument('--language', default='vi')
    ap.add_argument('--speakers', type=int)
    ap.add_argument('--diarize-model')
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    from faster_whisper.audio import decode_audio
    audio_s = len(decode_audio(args.input, sampling_rate=16000)) / 16000  # the worker's load_audio
    payload = {'model_path': str(Path(args.model).resolve()), 'input_path': str(Path(args.input).resolve()), 'language': args.language}
    if args.speakers:
        payload |= {'diarize_model_path': str(Path(args.diarize_model).resolve()), 'num_speakers': args.speakers}
    env = {**os.environ, 'THANHAM_PYTHON': str(Path(args.python).resolve()), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    failed = False
    with open(out / 'ram.csv', 'a', encoding='utf-8', newline='\n') as ram:
        if ram.tell() == 0:
            ram.write('round,engine,exit,wall_s,peak_ws_mb,audio_s,worker_cpu_s,others_cores,avail_mb_start,cpu_pct_start,avail_mb_end,'
                      'cpu_pct_end\n')
        for r in range(1, args.rounds + 1):
            runs = {}
            for engine in ('python', 'rust'):
                request = {'protocol': 1, 'id': f'stt-{r}', 'operation': 'stt', 'output_dir': str(out / f'{engine}{r}'), 'payload': payload}
                argv = [args.python, '-I', '-X', 'utf8', str(HERE.parents[1] / 'worker' / 'main.py')] if engine == 'python' else [args.exe]
                code, lines, wall, peak, load = runs[engine] = run(argv, request, env, out / f'{engine}{r}')
                ram.write(f'{r},{engine},{code},{wall:.1f},{peak:.0f},{audio_s:.1f},{load["worker_cpu_s"]:.1f},{load["others_cores"]:.2f},'
                          f'{load["avail_mb_start"]:.0f},{load["cpu_pct_start"]:.0f},{load["avail_mb_end"]:.0f},{load["cpu_pct_end"]:.0f}\n')
                ram.flush()
                print(f'round {r} {engine}: exit {code}, {wall:.1f} s, peak working set {peak:.0f} MB, load {json.dumps(load)}', flush=True)
            pe, re_ = ([json.loads(ln) for ln in runs[e][1]] for e in ('python', 'rust'))
            diffs = [f'exit code: python {runs["python"][0]}, rust {runs["rust"][0]}'] if runs['python'][0] != runs['rust'][0] else []
            for i in range(max(len(pe), len(re_))):
                a, b = (pe[i] if i < len(pe) else None), (re_[i] if i < len(re_) else None)
                if a != b:
                    diffs.append(f'event {i}: python {json.dumps(a, ensure_ascii=False)[:300]}\n'
                                 f'          rust   {json.dumps(b, ensure_ascii=False)[:300]}')
            result = next((e['result'] for e in pe if 'result' in e), None)
            summary = {'audio_s': round(audio_s, 1), 'rtf': {e: round(runs[e][2] / audio_s, 3) for e in runs}, 'events': len(pe),
                       'rows': len(result['segments']) if result else None, 'language': result and result.get('language'),
                       'speakers': sorted({s['speaker'] for s in result['segments'] if 'speaker' in s}) if result else None,
                       'identical': not diffs}
            print(json.dumps(summary, ensure_ascii=False))
            for d in diffs[:20]:
                print('DIFF', d)
            failed |= bool(diffs) or runs['python'][0] != 0
            (out / f'summary{r}.json').write_text(json.dumps({'summary': summary, 'differences': diffs}, ensure_ascii=False, indent=1),
                                                 encoding='utf-8')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
