//! A small Hugging Face file client with the observable behaviour of `huggingface_hub.hf_hub_download(local_dir=...)` 2.4.0,
//! which the Python worker uses (row W): one HEAD for the metadata, one GET (resumed by `Range` after a dropped
//! connection), 10 MiB write chunks, the retry and backoff rules, the `.cache/huggingface` bookkeeping files in the
//! staging folder, and the error class names the desktop message shows.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::time::Duration;

/// `DOWNLOAD_CHUNK_SIZE`: the client writes whole chunks only, so a dropped connection resumes at a multiple of it.
const CHUNK: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;
const RETRY_STATUS: &[u16] = &[408, 429, 500, 502, 503, 504];
/// Written as text on Windows by the Python client, so the line breaks are CRLF (195 bytes).
const CACHEDIR_TAG: &str = "Signature: 8a477f597d28d172789f06886806bc55\r\n# This file is a cache directory tag created by huggingface_hub.\r\n# For information about cache directory tags, see:\r\n#\thttps://bford.info/cachedir/\r\n";
const HUB_HOSTS: &[&str] = &["huggingface.co", "hf.co"];

/// A failed download, carrying the class name Python's exception would have (`type(error).__name__`).
#[derive(Debug)]
pub struct HubError {
    /// Python exception class name shown in the desktop message.
    pub class: &'static str,
    /// Detail for the log.
    pub detail: String,
}

fn err(class: &'static str, detail: impl Into<String>) -> HubError {
    HubError { class, detail: detail.into() }
}

type Res<T> = std::result::Result<T, HubError>;

/// Waits used between retries; tests shorten them.
fn sleep(seconds: f64) {
    let scale: f64 = std::env::var("THANHAM_HUB_SLEEP_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    std::thread::sleep(Duration::from_secs_f64(seconds * scale));
}

/// The HTTP clients: one that follows no redirects (HEAD, followed by hand), one that does (GET).
pub struct Hub {
    endpoint: String,
    head: reqwest::blocking::Client,
    get: reqwest::blocking::Client,
}

fn build_client(follow: bool) -> Res<reqwest::blocking::Client> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(concat!("thanham-worker/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        // The metadata call has a 10 s limit (`HF_HUB_ETAG_TIMEOUT`); a body has none here, `stream_once` times each wait.
        .timeout(if follow { None } else { Some(Duration::from_secs(10)) })
        .redirect(if follow { reqwest::redirect::Policy::default() } else { reqwest::redirect::Policy::none() });
    // Like Python's `ssl` default context under `SSL_CERT_FILE`: extra roots on top of the Windows certificate store.
    if let Some(path) = std::env::var_os("SSL_CERT_FILE").filter(|p| Path::new(p).is_file()) {
        if let Ok(pem) = fs::read(&path) {
            if let Ok(certs) = reqwest::Certificate::from_pem_bundle(&pem) {
                builder = builder.tls_certs_merge(certs);
            }
        }
    }
    builder.build().map_err(|e| err("ConnectError", e.to_string()))
}

impl Hub {
    /// Clients for the endpoint named by `HF_ENDPOINT` (default `https://huggingface.co`).
    pub fn new() -> Res<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let endpoint = std::env::var("HF_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://huggingface.co".into());
        Ok(Self {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            head: build_client(false)?,
            get: build_client(true)?,
        })
    }

    /// `hf_hub_url`: `<endpoint>/<repo>/resolve/<revision>/<filename>`.
    pub fn url(&self, repo: &str, filename: &str, revision: &str) -> String {
        format!("{}/{}/resolve/{}/{}", self.endpoint, repo, quote(revision, ""), quote(filename, "/"))
    }
}

/// `urllib.parse.quote`: keep letters, digits and `_.-~`, plus the `safe` characters.
fn quote(text: &str, safe: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || "_.-~".contains(c) || safe.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn origin(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let scheme = url.split_once("://").map_or("", |(s, _)| s).to_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_lowercase();
    let default_port = if scheme == "https" { ":443" } else { ":80" };
    format!("{scheme}://{}", authority.strip_suffix(default_port).unwrap_or(&authority))
}

fn same_or_hub_host(url: &str, target: &str) -> bool {
    let target_origin = origin(target);
    let host = target_origin.split_once("://").map_or("", |(_, h)| h);
    target_origin == origin(url) || (target_origin.starts_with("https://") && HUB_HOSTS.contains(&host))
}

fn join(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }
    let root = origin(base);
    if location.starts_with('/') {
        return format!("{root}{location}");
    }
    let dir = base.rsplit_once('/').map_or(base, |(d, _)| d);
    format!("{dir}/{location}")
}

fn header(response: &reqwest::blocking::Response, name: &str) -> Option<String> {
    response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// The exception class `hf_raise_for_status` raises for an error response.
fn status_class(response: &reqwest::blocking::Response) -> &'static str {
    match header(response, "X-Error-Code").as_deref() {
        Some("RepoNotFound") => "RepositoryNotFoundError",
        Some("RevisionNotFound") => "RevisionNotFoundError",
        Some("EntryNotFound") => "RemoteEntryNotFoundError",
        Some("GatedRepo") => "GatedRepoError",
        _ => "HfHubHTTPError",
    }
}

fn transport_class(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "ReadTimeout"
    } else if error.is_connect() {
        "ConnectError"
    } else {
        "RemoteProtocolError"
    }
}

/// `Retry-After` in whole seconds.
fn retry_after(response: &reqwest::blocking::Response) -> Option<f64> {
    header(response, "Retry-After").and_then(|v| v.trim().parse::<f64>().ok())
}

/// What the HEAD call learned about a file.
struct Metadata {
    commit_hash: Option<String>,
    etag: Option<String>,
    location: String,
    size: Option<u64>,
}

enum HeadFailure {
    /// A transport error or a retryable status: tried again with backoff when no local file exists.
    Retryable(HubError),
    /// Anything else the client reports at once.
    Final(HubError),
    /// A reply without the headers a Hub endpoint always sets.
    Metadata(String),
}

impl Hub {
    fn head_once(&self, url: &str) -> std::result::Result<Metadata, (HeadFailure, Option<f64>)> {
        let mut current = url.to_string();
        for _ in 0..MAX_REDIRECTS {
            let response = self
                .head
                .head(&current)
                .header("Accept-Encoding", "identity")
                .send()
                .map_err(|e| (HeadFailure::Retryable(err(transport_class(&e), e.to_string())), None))?;
            let status = response.status().as_u16();
            if status >= 400 {
                let class = status_class(&response);
                let wait = retry_after(&response);
                let failure = err(class, format!("HTTP {status}"));
                let retryable = RETRY_STATUS.contains(&status) && class == "HfHubHTTPError";
                return Err((
                    if retryable { HeadFailure::Retryable(failure) } else { HeadFailure::Final(failure) },
                    wait,
                ));
            }
            let location = header(&response, "Location").filter(|_| response.status().is_redirection());
            if let Some(loc) = location {
                let target = join(&current, &loc);
                if same_or_hub_host(&current, &target) {
                    current = target;
                    continue;
                }
            }
            let linked_etag = header(&response, "X-Linked-Etag").filter(|s| !s.is_empty());
            let etag =
                linked_etag.or_else(|| header(&response, "ETag").filter(|s| !s.is_empty())).map(|e| normalize_etag(&e));
            let redirect = response.status().is_redirection();
            let size = header(&response, "X-Linked-Size")
                .filter(|s| !s.is_empty())
                .or_else(|| if redirect { None } else { header(&response, "Content-Length") })
                .and_then(|s| s.trim().parse::<u64>().ok());
            return Ok(Metadata {
                commit_hash: header(&response, "X-Repo-Commit"),
                etag,
                location: header(&response, "Location").map(|l| join(&current, &l)).unwrap_or(current),
                size,
            });
        }
        Err((HeadFailure::Final(err("TooManyRedirects", url)), None))
    }

    /// `http_backoff(max_retries=5)`: up to 6 attempts, waits 1, 2, 4, 8, 8 s (or the server's `Retry-After` + 1).
    fn head_with_backoff(&self, url: &str, retries: bool) -> std::result::Result<Metadata, HeadFailure> {
        let (mut tries, mut wait) = (0, 1.0f64);
        loop {
            tries += 1;
            match self.head_once(url) {
                Ok(meta) => return Ok(meta),
                Err((HeadFailure::Retryable(e), server_wait)) if retries && tries <= 5 => {
                    let _ = e;
                    sleep(server_wait.map_or(wait, |w| w + 1.0));
                    wait = (wait * 2.0).min(8.0);
                }
                Err((failure, _)) => return Err(failure),
            }
        }
    }

    fn metadata(&self, url: &str, retries: bool) -> std::result::Result<Metadata, HeadFailure> {
        let meta = self.head_with_backoff(url, retries)?;
        if meta.commit_hash.is_none() {
            return Err(HeadFailure::Metadata("missing X-Repo-Commit".into()));
        }
        if meta.etag.is_none() {
            return Err(HeadFailure::Metadata("missing ETag".into()));
        }
        Ok(meta)
    }
}

fn normalize_etag(etag: &str) -> String {
    etag.trim_start_matches(['W', '/']).trim_matches('"').to_string()
}

struct LocalPaths {
    file: PathBuf,
    metadata: PathBuf,
    download_dir: PathBuf,
}

/// `get_local_download_paths`: creates the folders and the `.cache/huggingface` bookkeeping files.
fn local_paths(local_dir: &Path, filename: &str) -> Res<LocalPaths> {
    let io = |e: std::io::Error| err("OSError", e.to_string());
    if filename.is_empty()
        || filename.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        || filename.contains('\\')
    {
        return Err(err("ValueError", format!("Invalid filename: {filename}")));
    }
    let relative: PathBuf = filename.split('/').collect();
    let huggingface = local_dir.join(".cache").join("huggingface");
    fs::create_dir_all(&huggingface).map_err(io)?;
    let tag = huggingface.join("CACHEDIR.TAG");
    if !tag.exists() {
        let _ = fs::write(&tag, CACHEDIR_TAG);
    }
    let ignore = huggingface.join(".gitignore");
    if !ignore.exists() {
        let _ = fs::write(&ignore, "*");
    }
    let file = local_dir.join(&relative);
    let mut metadata = huggingface.join("download").join(&relative).into_os_string();
    metadata.push(".metadata");
    let metadata = PathBuf::from(metadata);
    fs::create_dir_all(file.parent().unwrap_or(local_dir)).map_err(io)?;
    fs::create_dir_all(metadata.parent().unwrap_or(local_dir)).map_err(io)?;
    Ok(LocalPaths { file, download_dir: huggingface.join("download"), metadata })
}

fn write_metadata(paths: &LocalPaths, commit: &str, etag: &str) -> Res<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    fs::write(&paths.metadata, format!("{commit}\n{etag}\n{now}\n")).map_err(|e| err("OSError", e.to_string()))
}

fn is_commit_hash(revision: &str) -> bool {
    revision.len() == 40 && revision.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl Hub {
    /// `hf_hub_download(repo_id, filename, revision=..., local_dir=local_dir)`: returns the downloaded file's path.
    pub fn download(&self, repo: &str, filename: &str, revision: &str, local_dir: &Path) -> Res<PathBuf> {
        let paths = local_paths(local_dir, filename)?;
        // Local file exists + metadata exists + commit_hash matches => return file.
        if is_commit_hash(revision) && paths.file.is_file() {
            if let Ok(text) = fs::read_to_string(&paths.metadata) {
                if text.lines().next() == Some(revision) {
                    return Ok(paths.file);
                }
            }
        }
        let url = self.url(repo, filename, revision);
        let meta = match self.metadata(&url, false) {
            Ok(meta) => meta,
            Err(first) => {
                // "No local file found. Retrying.." with backoff, when the failure was a transport error or a retryable status.
                let again = match first {
                    HeadFailure::Retryable(_) => self.metadata(&url, true),
                    other => Err(other),
                };
                match again {
                    Ok(meta) => meta,
                    Err(HeadFailure::Final(e)) | Err(HeadFailure::Retryable(e)) => return Err(head_error(e)),
                    Err(HeadFailure::Metadata(detail)) => return Err(err("LocalEntryNotFoundError", detail)),
                }
            }
        };
        let (commit, etag) = (meta.commit_hash.expect("checked"), meta.etag.expect("checked"));
        // In case of a redirect, the GET goes to the location directly.
        let target = if meta.location != url { meta.location.clone() } else { url.clone() };
        let _ = fs::remove_file(&paths.file);
        let name: String = filename.replace('/', std::path::MAIN_SEPARATOR_STR);
        let tmp = paths
            .download_dir
            .join(format!("{name}.{etag}.{}.incomplete", &uuid::Uuid::new_v4().simple().to_string()[..8]));
        if let Some(parent) = tmp.parent() {
            fs::create_dir_all(parent).map_err(|e| err("OSError", e.to_string()))?;
        }
        let outcome = (|| {
            let mut file = File::create(&tmp).map_err(|e| err("OSError", e.to_string()))?;
            self.http_get(&target, &mut file, meta.size)?;
            drop(file);
            crate::paths::replace_with_retry(&tmp, &paths.file).map_err(|e| err("OSError", e.to_string()))
        })();
        let _ = fs::remove_file(&tmp); // no partial file is kept: its name is unique to this download
        outcome?;
        write_metadata(&paths, &commit, &etag)?;
        Ok(paths.file)
    }

    /// `http_get`: stream `url` into `file` in whole 10 MiB chunks, resuming after a dropped connection.
    fn http_get(&self, url: &str, file: &mut File, expected: Option<u64>) -> Res<()> {
        let (mut expected, mut resume, mut retries) = (expected, 0u64, 5);
        let mut written = 0u64;
        loop {
            if expected == Some(resume) {
                return Ok(());
            }
            match self.stream_once(url, file, &mut expected, &mut resume, &mut written, &mut retries) {
                Ok(()) => break,
                Err(StreamFailure::Final(e)) => return Err(e),
                Err(StreamFailure::Transient(e)) => {
                    if retries <= 0 {
                        return Err(e);
                    }
                    sleep(1.0);
                    resume = written;
                    retries -= 1;
                }
            }
        }
        match expected {
            Some(size) if size != written => Err(err(
                "OSError",
                format!("Consistency check failed: file should be of size {size} but has size {written}"),
            )),
            _ => Ok(()),
        }
    }

    fn stream_once(
        &self,
        url: &str,
        file: &mut File,
        expected: &mut Option<u64>,
        resume: &mut u64,
        written: &mut u64,
        retries: &mut i32,
    ) -> std::result::Result<(), StreamFailure> {
        use StreamFailure::{Final, Transient};
        let io = |e: std::io::Error| Final(err("OSError", e.to_string()));
        let (info, body) = self.open_get(url, *resume)?;
        if *resume > 0 && info.status == 200 {
            // The server ignored the Range header: start the file over.
            file.set_len(0).map_err(io)?;
            std::io::Seek::seek(file, std::io::SeekFrom::Start(0)).map_err(io)?;
            *resume = 0;
        }
        *written = *resume;
        if expected.is_none() {
            *expected = info.length;
        }
        // Whole chunks only reach the file; a chunk still being filled when the connection drops is lost, as in the Python client.
        let mut pending: Vec<u8> = Vec::with_capacity(CHUNK + PUMP_READ);
        loop {
            match body.recv_timeout(Duration::from_secs(10)) {
                Ok(Msg::Data(data)) => {
                    pending.extend_from_slice(&data);
                    while pending.len() >= CHUNK {
                        file.write_all(&pending[..CHUNK]).map_err(io)?;
                        pending.drain(..CHUNK);
                        *written += CHUNK as u64;
                        *retries = 5; // some data arrived: the retry budget is full again
                    }
                }
                Ok(Msg::Done) => {
                    if !pending.is_empty() {
                        file.write_all(&pending).map_err(io)?;
                        *written += pending.len() as u64;
                        *retries = 5;
                    }
                    return Ok(());
                }
                Ok(Msg::Failed(e)) => return Err(Transient(e)),
                Ok(Msg::Status(_)) => unreachable!("the status arrives once, in open_get"),
                Err(RecvTimeoutError::Timeout) => return Err(Transient(err("ReadTimeout", "no data for 10 s"))),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Transient(err("RemoteProtocolError", "reader stopped")))
                }
            }
        }
    }

    /// GET with `Range` when resuming; 408 and 429 are retried with backoff, any other error status is final.
    /// The request and the body are read on a helper thread so that every wait can be bounded.
    fn open_get(&self, url: &str, resume: u64) -> std::result::Result<(GetInfo, Receiver<Msg>), StreamFailure> {
        let (mut tries, mut wait) = (0, 1.0f64);
        loop {
            tries += 1;
            let rx = pump(self.get.clone(), url.to_string(), resume);
            let info = match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Msg::Status(info)) => info,
                Ok(Msg::Failed(e)) => return Err(StreamFailure::Transient(e)),
                Ok(_) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(StreamFailure::Transient(err("RemoteProtocolError", "reader stopped")))
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(StreamFailure::Transient(err("ReadTimeout", "no response for 10 s")))
                }
            };
            if (info.status == 408 || info.status == 429) && tries <= 5 {
                sleep(info.retry_after.map_or(wait, |w| w + 1.0));
                wait = (wait * 2.0).min(8.0);
                continue;
            }
            if info.status >= 400 {
                return Err(StreamFailure::Final(err(info.class, format!("HTTP {}", info.status))));
            }
            return Ok((info, rx));
        }
    }
}

const PUMP_READ: usize = 256 * 1024;

/// What the helper thread reports about a GET response.
struct GetInfo {
    status: u16,
    length: Option<u64>,
    retry_after: Option<f64>,
    class: &'static str,
}

enum Msg {
    Status(GetInfo),
    Data(Vec<u8>),
    Done,
    Failed(HubError),
}

fn pump(client: reqwest::blocking::Client, url: String, resume: u64) -> Receiver<Msg> {
    let (tx, rx) = sync_channel(8);
    std::thread::spawn(move || {
        let mut request = client.get(&url);
        if resume > 0 {
            request = request.header("Range", format!("bytes={resume}-"));
        }
        let mut response = match request.send() {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(Msg::Failed(err(transport_class(&e), e.to_string())));
                return;
            }
        };
        let status = response.status().as_u16();
        let info = GetInfo {
            status,
            length: response_length(&response),
            retry_after: retry_after(&response),
            class: status_class(&response),
        };
        if tx.send(Msg::Status(info)).is_err() || status >= 400 {
            return;
        }
        let mut buffer = vec![0u8; PUMP_READ];
        loop {
            match response.read(&mut buffer) {
                Ok(0) => {
                    let _ = tx.send(Msg::Done);
                    return;
                }
                Ok(n) => {
                    if tx.send(Msg::Data(buffer[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Msg::Failed(err("RemoteProtocolError", e.to_string())));
                    return;
                }
            }
        }
    });
    rx
}

enum StreamFailure {
    Transient(HubError),
    Final(HubError),
}

/// `_get_file_length_from_http_response`: the total from `Content-Range`, else `Content-Length` (unless encoded).
fn response_length(response: &reqwest::blocking::Response) -> Option<u64> {
    if let Some(total) =
        header(response, "Content-Range").and_then(|v| v.rsplit('/').next().and_then(|t| t.trim().parse::<u64>().ok()))
    {
        return Some(total);
    }
    if header(response, "Content-Encoding").is_some() {
        return None;
    }
    header(response, "Content-Length").and_then(|v| v.trim().parse().ok())
}

/// `_raise_on_head_call_error`: a 401 and the repository errors surface as they are, everything else is "not found locally".
fn head_error(error: HubError) -> HubError {
    let reaches_user = matches!(
        error.class,
        "RepositoryNotFoundError" | "GatedRepoError" | "RevisionNotFoundError" | "RemoteEntryNotFoundError"
    ) || error.detail == "HTTP 401";
    if reaches_user {
        error
    } else {
        err("LocalEntryNotFoundError", error.detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_quote_like_urllib() {
        assert_eq!(quote("onnx_update/vi t.json", "/"), "onnx_update/vi%20t.json");
        assert_eq!(quote("a/b", ""), "a%2Fb");
        let mut hub = Hub::new().unwrap();
        hub.endpoint = "https://huggingface.co".into();
        assert_eq!(
            hub.url("csukuangfj/x", "model.onnx", "abc123"),
            "https://huggingface.co/csukuangfj/x/resolve/abc123/model.onnx"
        );
    }

    #[test]
    fn etags_are_normalised_like_huggingface_hub() {
        assert_eq!(normalize_etag("\"abc\""), "abc");
        assert_eq!(normalize_etag("W/\"abc\""), "abc");
    }

    #[test]
    fn redirects_stay_on_the_same_or_a_hub_host() {
        let url = "http://127.0.0.1:18081/r/resolve/v/f";
        assert!(same_or_hub_host(url, "http://127.0.0.1:18081/other"));
        assert!(same_or_hub_host("https://mirror.example/x", "https://huggingface.co/y"));
        assert!(!same_or_hub_host("https://huggingface.co/x", "https://cdn-lfs.example/y"));
        assert_eq!(join("http://h:1/a/b/c", "/d"), "http://h:1/d");
        assert_eq!(join("http://h:1/a/b/c", "d"), "http://h:1/a/b/d");
    }

    #[test]
    fn head_errors_surface_like_python() {
        assert_eq!(head_error(err("HfHubHTTPError", "HTTP 401")).class, "HfHubHTTPError");
        assert_eq!(head_error(err("HfHubHTTPError", "HTTP 404")).class, "LocalEntryNotFoundError");
        assert_eq!(head_error(err("RemoteEntryNotFoundError", "HTTP 404")).class, "RemoteEntryNotFoundError");
    }
}
