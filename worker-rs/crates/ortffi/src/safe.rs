//! RAII wrappers over [`crate::raw`]. No `unsafe` here.
#![forbid(unsafe_code)]

use crate::error::{Error, OrtError};
use crate::raw::sys::*;
use crate::raw::{
    Api, Element, ElementType, EnvKind, Handle, MemoryInfoKind, SessionKind, SessionOptionsKind, TensorInfo, ValueKind,
};
use std::ffi::CString;
use std::path::Path;
use std::sync::Arc;

fn c_string(text: &str) -> Result<CString, OrtError> {
    CString::new(text).map_err(|_| OrtError::invalid_argument(format!("{text:?} contains a NUL")))
}

/// `GraphOptimizationLevel`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphOptimizationLevel {
    /// `ORT_DISABLE_ALL`
    DisableAll,
    /// `ORT_ENABLE_BASIC`
    Basic,
    /// `ORT_ENABLE_EXTENDED`
    Extended,
    /// `ORT_ENABLE_LAYOUT`
    Layout,
    /// `ORT_ENABLE_ALL` (Python's default)
    All,
}

/// `ExecutionMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionMode {
    /// `ORT_SEQUENTIAL` (Python's default)
    Sequential,
    /// `ORT_PARALLEL`
    Parallel,
}

struct EnvInner {
    api: Api,
    memory: Handle<'static, MemoryInfoKind>,
    env: Handle<'static, EnvKind>,
}

/// The loaded runtime plus its `OrtEnv`. Cheap to clone; sessions keep it alive.
#[derive(Clone)]
pub struct Env {
    inner: Arc<EnvInner>,
}

impl Env {
    /// Loads the ONNX Runtime DLL at the absolute path `dll`, checks it is 1.31.1 / API 31 and
    /// creates the environment. Load failures are [`Error::Load`] (`RUNTIME_MISSING`).
    pub fn load(dll: &Path, logid: &str) -> Result<Env, Error> {
        let api = Api::load(dll)?;
        let env = api.create_env(&c_string(logid)?)?;
        let memory = api.create_cpu_memory_info()?;
        Ok(Env { inner: Arc::new(EnvInner { api, memory, env }) })
    }

    /// The pinned runtime release.
    pub fn version(&self) -> &'static str {
        ORT_VERSION
    }

    /// A tensor that reads `data` in place (no copy). `shape` must multiply out to `data.len()`.
    pub fn tensor<'a, T: Element>(&self, data: &'a [T], shape: &[i64]) -> Result<Value<'a>, Error> {
        let handle = self.inner.api.create_tensor(&self.inner.memory, data, shape)?;
        Ok(Value { api: self.inner.api, handle })
    }
}

/// Session creation options.
pub struct SessionOptions {
    api: Api,
    handle: Handle<'static, SessionOptionsKind>,
}

impl SessionOptions {
    /// ORT's defaults.
    pub fn new(env: &Env) -> Result<Self, Error> {
        let api = env.inner.api;
        Ok(Self { api, handle: api.create_session_options()? })
    }

    /// Threads inside one operator (Python `intra_op_num_threads`).
    pub fn intra_op_threads(&mut self, n: i32) -> Result<&mut Self, Error> {
        self.api.set_intra_op_threads(&mut self.handle, n)?;
        Ok(self)
    }

    /// Threads across operators (Python `inter_op_num_threads`).
    pub fn inter_op_threads(&mut self, n: i32) -> Result<&mut Self, Error> {
        self.api.set_inter_op_threads(&mut self.handle, n)?;
        Ok(self)
    }

    /// Python `graph_optimization_level`.
    pub fn graph_optimization_level(&mut self, level: GraphOptimizationLevel) -> Result<&mut Self, Error> {
        let raw = match level {
            GraphOptimizationLevel::DisableAll => ORT_DISABLE_ALL,
            GraphOptimizationLevel::Basic => ORT_ENABLE_BASIC,
            GraphOptimizationLevel::Extended => ORT_ENABLE_EXTENDED,
            GraphOptimizationLevel::Layout => ORT_ENABLE_LAYOUT,
            GraphOptimizationLevel::All => ORT_ENABLE_ALL,
        };
        self.api.set_graph_optimization_level(&mut self.handle, raw)?;
        Ok(self)
    }

    /// Python `execution_mode`.
    pub fn execution_mode(&mut self, mode: ExecutionMode) -> Result<&mut Self, Error> {
        let raw = match mode {
            ExecutionMode::Sequential => ORT_SEQUENTIAL,
            ExecutionMode::Parallel => ORT_PARALLEL,
        };
        self.api.set_execution_mode(&mut self.handle, raw)?;
        Ok(self)
    }

    /// Python `enable_cpu_mem_arena`.
    pub fn cpu_mem_arena(&mut self, enabled: bool) -> Result<&mut Self, Error> {
        self.api.set_cpu_mem_arena(&mut self.handle, enabled)?;
        Ok(self)
    }

    /// Python `log_severity_level` (0 verbose, 1 info, 2 warning, 3 error, 4 fatal).
    pub fn log_severity_level(&mut self, level: i32) -> Result<&mut Self, Error> {
        self.api.set_log_severity_level(&mut self.handle, level)?;
        Ok(self)
    }

    /// Python `add_session_config_entry`.
    pub fn config_entry(&mut self, key: &str, value: &str) -> Result<&mut Self, Error> {
        self.api.add_config_entry(&mut self.handle, &c_string(key)?, &c_string(value)?)?;
        Ok(self)
    }
}

/// Name and tensor description of one model input or output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IoInfo {
    /// The graph name.
    pub name: String,
    /// Element type and shape; `None` for sequences, maps and other non-tensors.
    pub tensor: Option<TensorInfo>,
}

/// A loaded model.
pub struct Session {
    // Field order matters: the session is released before the environment it was created in.
    handle: Handle<'static, SessionKind>,
    env: Env,
    inputs: Vec<IoInfo>,
    outputs: Vec<IoInfo>,
}

impl Session {
    /// Loads the model at `path` (external data files next to it are found by ORT).
    pub fn from_file(env: &Env, path: &Path, options: &SessionOptions) -> Result<Session, Error> {
        let api = env.inner.api;
        let handle = api.create_session(&env.inner.env, path, &options.handle)?;
        let describe = |inputs: bool| -> Result<Vec<IoInfo>, OrtError> {
            (0..api.session_io_count(&handle, inputs)?)
                .map(|i| {
                    Ok(IoInfo {
                        name: api.session_io_name(&handle, i, inputs)?,
                        tensor: api.session_io_info(&handle, i, inputs)?,
                    })
                })
                .collect()
        };
        let (inputs, outputs) = (describe(true)?, describe(false)?);
        Ok(Session { handle, env: env.clone(), inputs, outputs })
    }

    /// The model's inputs, in graph order.
    pub fn inputs(&self) -> &[IoInfo] {
        &self.inputs
    }

    /// The model's outputs, in graph order.
    pub fn outputs(&self) -> &[IoInfo] {
        &self.outputs
    }

    /// Runs the model. `inputs` pairs input names with values; the result has one value per name
    /// in `outputs`, in that order. May be called from several threads at once.
    pub fn run(&self, inputs: &[(&str, &Value<'_>)], outputs: &[&str]) -> Result<Vec<Value<'static>>, Error> {
        let api = self.env.inner.api;
        let in_names = inputs.iter().map(|(n, _)| c_string(n)).collect::<Result<Vec<_>, _>>()?;
        let out_names = outputs.iter().map(|n| c_string(n)).collect::<Result<Vec<_>, _>>()?;
        let in_refs: Vec<_> = in_names.iter().map(CString::as_c_str).collect();
        let out_refs: Vec<_> = out_names.iter().map(CString::as_c_str).collect();
        let values: Vec<_> = inputs.iter().map(|(_, v)| &v.handle).collect();
        let results = api.run(&self.handle, &in_refs, &values, &out_refs)?;
        Ok(results.into_iter().map(|handle| Value { api, handle }).collect())
    }
}

/// A tensor, either borrowed host memory (`Value<'a>`) or an output owned by ORT (`Value<'static>`).
pub struct Value<'a> {
    api: Api,
    handle: Handle<'a, ValueKind>,
}

impl Value<'_> {
    /// Element type and shape.
    pub fn info(&self) -> Result<TensorInfo, Error> {
        Ok(self.api.tensor_info(&self.handle)?)
    }

    /// The element type.
    pub fn element_type(&self) -> Result<ElementType, Error> {
        Ok(self.info()?.element)
    }

    /// The elements, if the tensor holds `T`.
    pub fn as_slice<T: Element>(&self) -> Result<&[T], Error> {
        Ok(self.api.tensor_data(&self.handle)?)
    }

    /// A copy of the elements, if the tensor holds `T`.
    pub fn to_vec<T: Element>(&self) -> Result<Vec<T>, Error> {
        Ok(self.as_slice()?.to_vec())
    }
}
