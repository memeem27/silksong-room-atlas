@echo off
setlocal
pushd "%~dp0"
set "APPDATA=%CD%/.appdata"
set "NUGET_PACKAGES=%CD%/.packages"
set "SCENE_SOURCE=%CD%/../ExtractionInput/Bundles/scenes_scenes_scenes"
if not "%~1"=="" set "SCENE_SOURCE=%~1"
dotnet run --project src/SilksongSceneViewer/SilksongSceneViewer.csproj -- --source "%SCENE_SOURCE%"
popd
endlocal
