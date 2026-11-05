@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "RUN="
where py >nul 2>&1 && set "RUN=py -3"
if not defined RUN where python >nul 2>&1 && set "RUN=python"
if not defined RUN (
  echo Installe Python 3 : https://www.python.org/downloads/
  echo Coche "Add python.exe to PATH" pendant l'installation.
  pause
  exit /b 1
)
%RUN% -c "import pynput" 1>nul 2>nul || %RUN% -m pip install -r "%~dp0requirements.txt"
%RUN% "%~dp0agent.py" %*
echo.
pause
