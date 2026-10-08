@echo off
title LAN Share Desktop
cd /d "%~dp0"

rem ---- locate python (py launcher preferred) ----
where py >nul 2>nul
if not errorlevel 1 goto :have_py
where python >nul 2>nul
if not errorlevel 1 goto :have_py_legacy
echo [ERROR] Python not found.
echo Please install Python 3.10+ from https://www.python.org/downloads/
echo and check "Add python.exe to PATH" during install.
pause
exit /b 1

:have_py_legacy
set "PYCMD=python"
goto :check_deps

:have_py
set "PYCMD=py"

:check_deps
%PYCMD% -c "import PySide6" >nul 2>nul
if not errorlevel 1 goto :launch
echo First run: installing PySide6, about 300MB one-time...
%PYCMD% -m pip install PySide6 --quiet
if not errorlevel 1 goto :launch
echo [ERROR] PySide6 install failed. Check your network and retry.
pause
exit /b 1

:launch
%PYCMD% -c "import desktop" 2>startup_error.log
if not errorlevel 1 goto :ok
echo [ERROR] Desktop app failed to start.
echo Details are in startup_error.log next to this file. Send it to me.
pause
exit /b 1

:ok
del startup_error.log >nul 2>nul
where pyw >nul 2>nul
if not errorlevel 1 goto :run_pyw
start "" %PYCMD% "%~dp0desktop.py"
exit /b 0

:run_pyw
start "" pyw "%~dp0desktop.py"
exit /b 0
