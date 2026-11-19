//! Speech to text (`stt`), ported from `worker/main.py`: the decode, the VAD, the glue of faster-whisper and, with the engine
//! (feature `ct2`), the operation.

pub mod decode;
pub mod diarize;
pub mod glue;
#[cfg(feature = "ct2")]
mod op;
pub mod vad;

#[cfg(feature = "ct2")]
pub use op::stt;
