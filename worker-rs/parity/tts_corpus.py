r"""tts_corpus.py <repo_root> <out.jsonl>: the text corpus of rows L and P1, from this repository only (so CI can rebuild it).

Quoted literals of the worker tests, the UI, e2e and docs, hand-written edge cases (numbers, abbreviations, English, Unicode, whitespace,
cues, pause marks, very long lines) and seeded mutations of the real lines; deterministic, deduplicated by exact text. Adapted from spike
S2's builder (tools/build_corpus.py), whose 30,992-line corpus also held local evidence that cannot be published.
"""
import json
import os
import random
import re
import sys
import unicodedata

REPO, OUT = sys.argv[1], sys.argv[2]
SKIP = ('node_modules', '.venv', 'site-packages', '/models/', '/target/', '/.git/', '__pycache__', '/dist/')
SEED = 20261118
PER_SOURCE_CAP = 1500  # keeps one huge transcript set from dominating
rng = random.Random(SEED)

VI = re.compile('[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]', re.I)
BAD = re.compile(r'^(?:[A-Za-z]:[\\/]|/|https?://|[0-9a-f]{16,}$)|[{}<>]=?\s*$|\\u[0-9a-f]{4}|^\s*[\[{]|[\\]{2}|\.(?:py|json|wav|mp3|onnx|exe|dll)\b', re.I)
TIME = re.compile(r'^\s*\d+\s*$|\d\d:\d\d:\d\d[,.]\d+\s*-->')


def ok_path(p):
    p = p.replace('\\', '/') + '/'
    return not any(s in p for s in SKIP)


def keep(s):
    s = s.strip()
    if not (6 <= len(s) <= 1200) or len(s.split()) < 2 or TIME.search(s) or BAD.search(s):
        return False
    letters = sum(c.isalpha() for c in s)
    return letters >= 0.55 * len(s) and (VI.search(s) is not None or letters >= 12)


def json_strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from json_strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from json_strings(v)


def read_text(p):
    for enc in ('utf-8-sig', 'utf-16'):
        try:
            return open(p, encoding=enc).read()
        except (UnicodeError, OSError):
            continue
    return ''


def file_lines(p):
    ext = os.path.splitext(p)[1].lower()
    t = read_text(p)
    if ext in ('.json',):
        try:
            for s in json_strings(json.loads(t)):
                yield from s.splitlines() if len(s) > 1200 else [s]
        except ValueError:
            pass
    elif ext == '.jsonl':
        for ln in t.splitlines():
            try:
                yield from json_strings(json.loads(ln))
            except ValueError:
                pass
    elif ext in ('.csv', '.tsv'):
        for ln in t.splitlines():
            yield from re.split(r'[\t,]', ln) if ext == '.tsv' else [ln]
    else:
        yield from t.splitlines()


def collect(root, exts, label):
    by = {}
    for r, ds, fs in os.walk(root):
        ds.sort()
        if not ok_path(r):
            continue
        for f in sorted(fs):
            if os.path.splitext(f)[1].lower() in exts:
                p = os.path.join(r, f)
                rel = os.path.relpath(p, root).replace('\\', '/')
                top = rel
                for s in file_lines(p):
                    s = s.strip()
                    if keep(s):
                        by.setdefault(label + ':' + top, []).append(s)
    return by


rows, seen = [], set()


def add(src, text):
    if text and text not in seen:
        seen.add(text)
        rows.append({'src': src, 'text': text})


# --- B. repo fixtures: quoted literals in tests and e2e ---
repo = {}
lit = re.compile(r'''(?:"((?:[^"\\\n]|\\.){6,400})"|'((?:[^'\\\n]|\\.){6,400})'|`([^`\n]{6,400})`)''')
for sub in ('worker/tests', 'src', 'e2e', 'docs', 'worker/voices.json', 'worker/SMOKE.md'):
    base = os.path.join(REPO, sub)
    paths = [base] if os.path.isfile(base) else [os.path.join(r, f) for r, ds, fs in sorted(os.walk(base)) if ok_path(r) for f in sorted(fs)]
    for p in paths:
        if os.path.splitext(p)[1].lower() not in ('.py', '.ts', '.tsx', '.json', '.md'):
            continue
        t = read_text(p)
        cands = [m for g in lit.findall(t) for m in g if m] if p.endswith(('.py', '.ts', '.tsx')) else [x for ln in t.splitlines() for x in [ln]]
        for s in cands:
            if keep(s) and (VI.search(s) or ' ' in s):
                repo.setdefault('repo:' + os.path.relpath(p, REPO).replace('\\', '/'), []).append(s.strip())

en_pool = []  # lines without Vietnamese diacritics: English docs, code-switch candidates; sampled below
for label, groups in (('repo', repo),):
    for src, lines in sorted(groups.items()):
        uniq = list(dict.fromkeys(lines))
        en_pool += [(src, s) for s in uniq if not VI.search(s)]
        uniq = [s for s in uniq if VI.search(s)]
        if len(uniq) > PER_SOURCE_CAP:
            uniq = sorted(rng.sample(uniq, PER_SOURCE_CAP), key=uniq.index)
        for s in uniq:
            add(src, s)
for src, s in rng.sample(en_pool, min(len(en_pool), 1000)):
    add('en:' + src, s)
real = [r['text'] for r in rows]

# --- C. edge cases (hand-written, deterministic) ---
NUM = ['0', '7', '10', '15', '100', '1000', '1.000', '1.234.567', '4.200,5', '0,5', '3.14', '12,75', '-3', '+84 901 234 567', '0901.234.567',
       '1/2', '3/4', '2,5 triệu', '1,2 tỷ', '50.000đ', '100$', '€25,50', '£3', '¥1000', '1e3', '2^10', 'x²', '10⁻³', '½', '⅔', '5‰', '99,9%', '100%', '0%', '45°C',
       '#1', 'No.5', 'số 3', 'tầng 12A', 'phòng 304', 'lớp 10A1', 'COVID-19', 'F-16', 'Boeing 747-8', 'iPhone 15 Pro Max', 'RTX 4090', 'MP3', 'H.264', 'USB-C', 'Wi-Fi 6E',
       '2026', '1945', '1/1/2000', '10/11/2026', '31-12-2025', 'ngày 5 tháng 3 năm 2024', 'tháng 12/2026', '12/2026', 'Q3/2026', '14h30', '9:05', '23:59:59', '7h', '0h15', '1h30p',
       'từ 8h đến 17h', '8-10 giờ', '5-7 ngày', '1.5 giờ', '3 km/h', '60km/h', '25 m2', '30m³', '5 kg', '500g', '2l', '10ml', '3GB', '256 GB', '1TB', '5G', '100Mbps', '2.4GHz', '220V', '5A', '60Hz',
       'I', 'II', 'IV', 'XIV', 'XX', 'thế kỷ XXI', 'Chương IV', 'Ⅳ', 'Ⅻ', '①', '②', '٣', '٣٤٥', '१२३', '１２３', 'ⅰ', '²', '³', '¹']
UNITS = ['m', 'km', 'cm', 'mm', 'kg', 'g', 'mg', 'h', 'ph', 's', 'ms', '%']
ABBR = ['TP.HCM', 'TP. Hồ Chí Minh', 'Hà Nội', 'UBND', 'UBND TP', 'GS.TS', 'PGS. TS. Nguyễn Văn A', 'ThS.', 'BS.', 'ĐH', 'THPT', 'THCS', 'CLB', 'CEO', 'CTO', 'AI', 'IoT', 'API', 'URL', 'HTML', 'CSS',
        'v.v.', 'vd.', 'tr.', 'nxb', 'TNHH', 'CP', 'VN-Index', 'GDP', 'FDI', 'USD', 'VND', 'EUR', 'kWh', 'dB', 'vs.', 'etc.', 'a.m.', 'p.m.', 'Mr. Smith', 'Dr. Lee', 'St. John', 'Inc.', 'Ltd.']
ENG = ['hello', 'Hello world', 'I love you', 'to do', 'in', 'y', 'a', 'the best', 'OK', 'ok', 'okay', 'Facebook', 'YouTube', 'TikTok', 'Google Maps', 'Windows 11', 'ChatGPT', 'machine learning', 'deep learning model',
       'email: abc@example.com', 'https://example.com/path?q=1&x=2', 'www.vnexpress.net', 'C:\\Users\\Admin\\file.txt', '/usr/local/bin', 'user_name123', 'camelCaseWord', 'snake_case_word', '#hashtag', '@mention',
       'Việt Nam number one', 'Tôi dùng iPhone và Samsung', 'meeting lúc 3pm', 'deadline là thứ Sáu', 'check-in', 'check out', 'online', 'offline', 'download file', 'update app', 'click vào đây', 'like và share']
SENS = ['café', 'naïve', 'señor', 'über', 'Straße', 'ÀÉÎÕÜ', 'ǅ', 'ǆ', 'Ǆ', 'ª', 'º', 'ß', 'İstanbul', 'ı', 'ŉ', 'ǰ', 'ΐ', 'ᾳ', 'ﬁ', 'ﬃ', 'Ω', 'Αθήνα', 'Москва', 'привет', 'Ελλάδα', 'שלום', 'مرحبا', 'こんにちは', '東京', '北京', '서울',
        'สวัสดี', 'नमस्ते', 'ñandú', 'ǈ', 'ᴀ', 'ꜰ', 'ℓ', 'ℝ', 'ℵ', '℃', '№', '™', '©', '®', '€', '†', '‡', '§', '¶', '‰', '″', '′']
UNI = ['\u00a0', '\u2002', '\u2003', '\u2009', '\u200a', '\u200b', '\u200c', '\u200d', '\u2060', '\u3000', '\u0085', '\u2028', '\u2029', '\ufeff', '\u180e', '\u1680', '\u202f', '\u205f',
       '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x1f', '\t', '\r', '\x00', '\x07', '\x7f']
EMO = ['😀', '👍', '👍🏽', '❤️', '🇻🇳', '🇺🇸', '👨‍👩‍👧‍👦', '🏳️‍🌈', '✔', '✅', '❌', '★', '☆', '→', '←', '↑', '⇒', '♪', '♫', '☎', '✉', '©2026', '🔥🔥🔥', '😂😂', '🥲', '🫠', '𝒜', '𝕏', '𠀀', '𝟙𝟚𝟛', '🅰', 'ⓐ', 'Ⓐ']
DIAC = ['Việt', 'Viêt', 'Việt', 'Hoà', 'Hòa', 'hoà bình', 'hòa bình', 'thuỷ', 'thủy', 'quý', 'qúy', 'Đà Nẵng', 'ĐÀ NẴNG', 'đà nẵng', 'ĐÀ NẴNG', 'ÂM THANH', 'âm thanh', 'ÂM  THANH', 'nghiêng', 'nghieng', 'khuỷu tay', 'ngoằn ngoèo', 'huỳnh', 'xoáy', 'loè loẹt', 'oà', 'uỷ ban']
PUNCT = ['Xin chào!!!', 'Thật không???', 'Ừ... được thôi...', 'Hả?!', 'Thật à?!?', '—', '–', 'Tôi — một người — đi', 'A - B', 'A-B', 'A_B', '"Xin chào," anh nói.', "'ổn' không?", '“Cảm ơn”', '‘ổn’', '«Salut»', '¿Qué?', '¡Hola!', '(ghi chú)', '[ghi chú]', '{x}', '<tag>', '<en>hello</en>', 'a/b', 'a\\b', 'a|b', 'a&b', 'a+b=c', 'a*b', 'a=b', 'a>b', 'a<b', 'a~b', 'a^b', 'a%b', '...', '..', '....', ',,', ';;', '::', '!?', '?!', '. . .', ', , ,', ' , ', 'a ,b', 'a , b', 'x.y', 'x. y', 'x .y', '3.', '.3', '..3', '-', '--', '---', '_', '__', '  ', ' a ', '   a   b   ']
CUES = ['[cười]', '[thở dài]', '[hắng giọng]', '[chuckle]', '[sigh]', '[clear throat]', '[Cười]', '[ cười ]', '[CHUCKLE]', '[nghỉ 1s]', '[nghỉ]', '[khác]', '[]', '[', ']', '[[cười]]', '<|emotion_1|>', '<|emotion_2|>', '<|emotion_3|>', '<|emotion_9|>', '<|emotion_|>',
        'Hôm nay vui quá [cười] thật đấy.', 'Mệt rồi [thở dài]. Thôi nghỉ đi.', '[hắng giọng] Xin chào mọi người.', 'Ha ha [chuckle], được rồi!', 'Xong [sigh]', '[cười][cười]', '[cười] [thở dài] [hắng giọng]',
        'Tôi nói <en>machine learning</en> và deep learning.', 'Đọc <en>OK</en>.', '<en>to do</en>', '<en>a</en> b', '</en>']
SHORT_EN = ['y', 'in', 'to do', 'a', 'to', 'on', 'it is', 'be', 'me', 'we', 'no', 'so', 'do', 'go', 'and', 'or', 'the', 'is', 'at', 'as', 'by', 'of', 'ơi', 'ô', 'y tế', 'in ra', 'to lớn', 'a lô', 'ok', 'OK.', 'ok.', 'to do.', 'I.', 'it.', 'y!', 'in?', 'to do,', 'in ơi', 'y y y', 'a b c', 'a b c d', 'a b c d e']
edge = {'num': NUM, 'abbr': ABBR, 'eng': ENG, 'ipa': SENS, 'ws': [], 'emoji': EMO, 'diac': DIAC, 'punct': PUNCT, 'cue': CUES, 'short': SHORT_EN}
ctx_vi = ['Giá hôm nay là {} đồng.', 'Anh ấy nói {} rồi đi.', 'Số liệu: {}', '{}', 'Tôi đọc {} cho các bạn nghe.', 'Theo {} thì đúng.']
for k, items in edge.items():
    for it in items:
        add(f'edge:{k}', it)
        add(f'edge:{k}:ctx', ctx_vi[(len(it) + ord(it[0])) % len(ctx_vi)].format(it))
for u in UNI:
    for tpl in ('Xin{}chào các bạn', 'Xin chào{}', '{}Xin chào', 'a{}b', 'số 12{}34', 'hello{}world', 'Việt{}Nam.'):
        add('edge:ws', tpl.format(u))
for n in NUM[:60]:
    for u in UNITS:
        add('edge:unit', f'{n} {u}')
        add('edge:unit', f'{n}{u}')
# NFD / NFC / NFKC / decomposed forms of real lines (Unicode normalization edge)
sample_real = rng.sample(real, min(len(real), 400)) if real else []
for s in sample_real[:150]:
    add('edge:nfd', unicodedata.normalize('NFD', s))
for s in sample_real[150:250]:
    add('edge:nfkc', unicodedata.normalize('NFKC', s))
for s in sample_real[250:300]:
    add('edge:nfd-partial', ''.join(unicodedata.normalize('NFD', c) if rng.random() < 0.3 else c for c in s))
# very long lines (paragraph-size and beyond)
long_src = [r for r in real if len(r) > 60] or ['Xin chào các bạn, hôm nay trời đẹp lắm.']
for n in (2000, 5000, 12000, 30000):
    buf = []
    while sum(map(len, buf)) < n:
        buf.append(rng.choice(long_src))
    add(f'edge:long{n}', ' '.join(buf)[:n])
# one unspaced token costs about n^3 in sea-g2p (Python and Rust alike: 1,600 chars = 8 s), so keep these below a second
add('edge:long-nospace', 'Việt' * 150)
add('edge:long-nospace', 'Việt' * 30)
add('edge:long-digits', '1234567890' * 800)
add('edge:long-punct', '.,!?' * 3000)
add('edge:long-ws', 'a' + ' ' * 5000 + 'b')
add('edge:long-newlines', 'Một.\n' * 800)
add('edge:long-word', 'Nghiêng' * 90)
# raw newlines / paragraphs (G2P-level only; the engine splits paragraphs before the front end)
for s in ('Dòng một.\nDòng hai.', 'A\r\nB', '\n\nXin chào\n\n', 'Xin chào\u2028bạn', 'a\n\n\nb', '\tXin chào\t', 'Xin\tchào'):
    add('edge:newline', s)

# pause marks (row L: split_pauses and its errors), bare and inside text
PAUSES = ['[nghỉ]', '[nghỉ 1s]', '[nghỉ 0,5s]', '[nghỉ 0.5 giây]', '[NGHỈ 250ms]', '[pause 2]', '[Pause 1.5 sec]', '[nghi 3 giay]', '[nghỉ 2 seconds]',
          '[nghỉ 0]', '[nghỉ 11s]', '[nghỉ 0.04s]', '[nghỉ abc]', '[nghỉ 2 secs]', '[pausex]', '[pausé]', '[nghı 2]', '[pauſe 1]', '[nghỉ 300mſ]',
          '[nghỉ ٣]', '[ nghỉ  1 s ]', '[nghỉ1s]', '[nghỉ 1s][nghỉ 2s]', '[nghỉ 1s] [cười] [nghỉ 1s]']
for p in PAUSES:
    for tpl in ('{}', 'Xin chào. {} Tạm biệt.', '{} Đầu câu.', 'Cuối câu {}', 'Hôm nay {}, trời đẹp.', 'A {} B {} C', 'Một{}hai'):
        add('edge:pause', tpl.replace('{}', p))

# --- D. seeded mutations of real lines (stress the normaliser and tokenizer with realistic shapes) ---
muts = {
    'upper': lambda s: s.upper(),
    'lower': lambda s: s.lower(),
    'title': lambda s: s.title(),
    'nopunct': lambda s: re.sub(r'[.,!?;:…]+', '', s),
    'noend': lambda s: s.rstrip(' .!?…'),
    'shout': lambda s: s.rstrip(' .!?…') + '!!!',
    'ellipsis': lambda s: s.rstrip(' .!?…') + '...',
    'digits': lambda s: re.sub(r'\b(\w+)\b', lambda m: str(rng.randint(1, 99999)) if rng.random() < 0.08 else m.group(1), s),
    'bracket': lambda s: f'({s})',
    'quote': lambda s: f'"{s}"',
    'doublesp': lambda s: s.replace(' ', '  ', 3),
    'strip-diac': lambda s: ''.join(c for c in unicodedata.normalize('NFD', s) if not unicodedata.combining(c)).replace('đ', 'd').replace('Đ', 'D'),
    'prefix-en': lambda s: 'OK ' + s,
    'suffix-num': lambda s: s.rstrip(' .') + ' 2026.',
    'emoji': lambda s: s + ' 😀',
    'cue': lambda s: '[cười] ' + s,
    'cue-mid': lambda s: (lambda w: ' '.join(w[:len(w) // 2] + ['[thở dài]'] + w[len(w) // 2:]))(s.split()),
}
pool = [r for r in real if len(r) < 400]
rng.shuffle(pool)
target_mut = 6000
names = sorted(muts)
i = 0
while pool and sum(1 for r in rows if r['src'].startswith('mut:')) < target_mut and i < 20 * target_mut:
    s = pool[i % len(pool)]
    name = names[i % len(names)]
    try:
        add('mut:' + name, muts[name](s))
    except Exception:  # noqa: BLE001
        pass
    i += 1

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
by = {}
for r in rows:
    k = r['src'].split(':')[0] + ':' + (r['src'].split(':')[1] if r['src'].startswith(('edge', 'mut')) else '')
    by[k] = by.get(k, 0) + 1
print(len(rows), 'rows;', sum(1 for r in rows if r['src'].startswith('repo')), 'real')
for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:60]:
    print(f'{v:6d} {k}')
