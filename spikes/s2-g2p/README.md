# S2 spike: G2P and tokens (row P1)

Question: does a pure-Rust path (sea-g2p-rs + tokenizers) give the same phonemes and token ids as the Python worker's VieNeu front end?
Results and verdict: `work\rm\s2-g2p\RESULTS.md` (outside the repo).

Recipe (paths relative to the machine layout; `$RT` = the repo's `runtime\python\python.exe`):

1. `python tools/build_corpus.py <work> <repo> corpus_raw.jsonl` collects local Vietnamese lines, edge cases and seeded mutations.
2. `$RT -I -X utf8 tools/record.py corpus_raw.jsonl <tokenizer.json> <repo>/worker/main.py <out>` adds the chunker's chunks and records
   `norm`, `g2p`, `worker`, `ids_g2p`, `ids_worker` as the worker produces them (`corpus.jsonl`, `golden.jsonl`, `meta.json`).
3. `cargo build --release` (regex backend fancy-regex) or `cargo build --release --no-default-features --features onig` (control, the backend of the Python wheel).
4. `s2-g2p <sea_g2p.bin> <tokenizer.json> corpus.jsonl golden.jsonl rust.jsonl`, then `python tools/compare.py corpus.jsonl golden.jsonl rust.jsonl report.json`.
5. Tokenizer-only stress: `$RT -I -X utf8 tools/tokfuzz_record.py ...`, `tokfuzz <tokenizer.json> tokfuzz_in.jsonl out.jsonl`, `python tools/tokfuzz_compare.py ...`.

`Cargo.lock` pins regex, regex-syntax, regex-automata, unicode-normalization, aho-corasick, memchr and memmap2 to the versions in the sea_g2p wheel's SBOM.
