@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 goto :run_py
where python >nul 2>nul
if not errorlevel 1 goto :run_python
echo [ERROR] Python not found. Please install Python 3.8+ from https://www.python.org/downloads/
pause
exit /b 1

:run_py
start "LAN Share" py server.py
exit /b 0

:run_python
start "LAN Share" python server.py
exit /b 0
