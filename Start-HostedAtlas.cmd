@echo off
setlocal
pushd "%~dp0"
set "SILKSONG_ATLAS_PORT=5181"
node .\Serve-HostedAtlas.js
popd
endlocal
