# oneDNN 3.1.1 static, the CT2 4.8.5 wheel's flags (prepare_build_environment_windows.sh:47), with /MT (the Rust worker is +crt-static).
. $PSScriptRoot\env.ps1
$src = Join-Path $Inputs 'src\oneDNN-3.1.1'
$bld = Join-Path $Root 'onednn-build'
$ins = Join-Path $Root 'onednn-install'
if (Test-Path -LiteralPath $bld) { Remove-Item -LiteralPath $bld -Recurse -Force }
cmake -S $src -B $bld -G Ninja -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_BUILD_TYPE=Release `
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5' -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
  -DCMAKE_INSTALL_PREFIX="$ins" `
  -DONEDNN_LIBRARY_TYPE=STATIC -DONEDNN_BUILD_EXAMPLES=OFF -DONEDNN_BUILD_TESTS=OFF -DONEDNN_ENABLE_WORKLOAD=INFERENCE `
  '-DONEDNN_ENABLE_PRIMITIVE=CONVOLUTION;REORDER' -DONEDNN_BUILD_GRAPH=OFF
if ($LASTEXITCODE -ne 0) { throw 'oneDNN configure failed' }
cmake --build $bld --target install --parallel 3
if ($LASTEXITCODE -ne 0) { throw 'oneDNN build failed' }
Copy-Item (Join-Path $ins 'lib\dnnl.lib') (Join-Path $Lib 'dnnl.lib') -Force
"oneDNN OK: $((Get-Item (Join-Path $Lib 'dnnl.lib')).Length) bytes"
