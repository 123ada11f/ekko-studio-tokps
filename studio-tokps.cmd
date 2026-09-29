@echo off
chcp 65001 >nul
setlocal
set "PY=py"
where py >nul 2>nul || set "PY=python"
if defined STUDIO_TOKPS_PY set "PY=%STUDIO_TOKPS_PY%"
"%PY%" "%~dp0studio_tokps.py" %*
if "%~1"=="" pause
