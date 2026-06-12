@echo off
title Academia SD - Google GenAI Installer (Force Mode)
color 0B

cd /d "%~dp0"

:: MAGIA: Le tapamos los ojos a Python para que no pueda leer tu carpeta AppData de Windows
set PYTHONNOUSERSITE=1

echo ========================================================
echo        Academia SD - Install Google GenAI API
echo ========================================================
echo.

set "PYTHON_CMD=.\python_embeded\python.exe"

if exist "%PYTHON_CMD%" (
    echo [AcademiaSD] ComfyUI Windows Portable environment detected!
) else (
    echo [AcademiaSD] ERROR: Could not find python_embeded.
    echo Please make sure this .bat file is in your ComfyUI Portable root folder.
    echo.
    pause
    exit /b
)

echo.
echo [AcademiaSD] 1/3 Updating pip...
%PYTHON_CMD% -s -m pip install --upgrade pip

echo.
echo [AcademiaSD] 2/3 Removing old conflicting Google libraries (if any)...
%PYTHON_CMD% -s -m pip uninstall -y google-generativeai

echo.
echo [AcademiaSD] 3/3 FORCE Installing the NEW Google GenAI SDK into ComfyUI...
:: TRUCO DEFINITIVO: Usamos --force-reinstall para evitar el mensaje de "Requirement already satisfied"
%PYTHON_CMD% -s -m pip install google-genai requests --force-reinstall --no-warn-script-location

echo.
echo ========================================================
echo   Installation Complete! You can now restart ComfyUI.
echo ========================================================
echo.
pause