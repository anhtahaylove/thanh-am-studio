//! Spike S1 probe: blocking reqwest 0.13 with the platform verifier, a custom root CA and the OS proxy settings.
//! usage: reqwest-probe <url> [--ca <pem>] [--only] [--no-proxy]
//!   default        platform verifier (the Windows certificate store), like Python's truststore (F22)
//!   --ca <pem>     additionally trust this root CA (tls_certs_merge)
//!   --only         trust only --ca (tls_certs_only)
//!   --no-proxy     ignore the system proxy
use std::error::Error;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(url) = args.first() else {
        eprintln!("usage: reqwest-probe <url> [--ca <pem>] [--only] [--no-proxy]");
        return ExitCode::from(2);
    };
    let flag = |f: &str| args.iter().any(|a| a == f);
    let ca = args.iter().position(|a| a == "--ca").and_then(|i| args.get(i + 1));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(20));
    if let Some(path) = ca {
        let pem = std::fs::read(path).expect("read --ca");
        let cert = reqwest::Certificate::from_pem(&pem).expect("parse --ca");
        builder = if flag("--only") { builder.tls_certs_only([cert]) } else { builder.tls_certs_merge([cert]) };
    }
    if flag("--no-proxy") {
        builder = builder.no_proxy();
    }
    match builder.build().and_then(|c| c.get(url).send()).and_then(|r| {
        let status = r.status().as_u16();
        r.text().map(|t| (status, t))
    }) {
        Ok((status, body)) => {
            println!("{{\"ok\":true,\"status\":{status},\"body\":{:?}}}", body.chars().take(80).collect::<String>());
            ExitCode::SUCCESS
        }
        Err(e) => {
            let mut chain = vec![e.to_string()];
            let mut src = e.source();
            while let Some(s) = src {
                chain.push(s.to_string());
                src = s.source();
            }
            println!("{{\"ok\":false,\"error\":{:?}}}", chain.join(" <- "));
            ExitCode::from(1)
        }
    }
}
