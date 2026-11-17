//! Tokenizer-only run: tokfuzz <tokenizer.json> <in.jsonl> <out.jsonl>
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, BufWriter, Write};
use tokenizers::Tokenizer;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let tok = Tokenizer::from_file(&a[1]).expect("tokenizer.json");
    let input = BufReader::new(std::fs::File::open(&a[2]).unwrap());
    let mut out = BufWriter::new(std::fs::File::create(&a[3]).unwrap());
    for line in input.lines() {
        let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let ids = tok.encode(v["text"].as_str().unwrap(), false).map(|e| e.get_ids().to_vec());
        match ids {
            Ok(ids) => writeln!(out, "{}", json!({"i": v["i"], "ids": ids})).unwrap(),
            Err(e) => writeln!(out, "{}", json!({"i": v["i"], "err": e.to_string()})).unwrap(),
        }
    }
}
