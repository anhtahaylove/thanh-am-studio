r"""Writes parity/stt/round.json (from spike S4): Python round(x, 2) and numpy np.round(np.float64(x), 2) on values shaped like the
ones faster-whisper rounds (seek/100 + k/50, silence k/16000 + t, exact binary ties, random), for the Rust test
stt::glue::tests::round2_matches_python_and_numpy.
usage: runtime\python\python.exe -I round_cases.py parity/stt/round.json"""
import json
import sys

import numpy as np

rng = np.random.default_rng(20261118)
xs = [k / 8 for k in range(400)] + [k / 16 for k in range(400)] + [k / 1024 for k in range(2048)]
xs += [s / 100 + k / 50 for s in range(0, 60000, 37) for k in (0, 1, 7, 49, 150, 1499)]
xs += [int(a) / 16000 + int(b) / 100 + int(c) / 50 for a, b, c in zip(rng.integers(0, 10**7, 3000), rng.integers(0, 60000, 3000), rng.integers(0, 1500, 3000))]
xs += [float(v) for v in rng.uniform(0, 2000, 3000)] + [-0.004, -0.005, -0.015, -1.255, 1e-300, 5e-324]
cases = [[x, round(x, 2), float(round(np.float64(x), 2))] for x in xs]
json.dump({'cases': cases}, open(sys.argv[1], 'w', encoding='utf-8'))
print(len(cases), 'cases;', sum(1 for _, p, n in cases if p != n), 'where Python and numpy rounding differ')
