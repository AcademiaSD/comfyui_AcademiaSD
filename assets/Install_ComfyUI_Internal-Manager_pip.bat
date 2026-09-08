@echo off
setlocal
title Install/Update ComfyUI-Manager (portable)

rem Trabaja siempre relativo a la carpeta donde esta este .bat
cd /d "%~dp0"

set "PY=%~dp0python_embeded\python.exe"

if not exist "%PY%" (
    echo [ERROR] No se encuentra python_embeded\python.exe
    echo Coloca este .bat en la carpeta ComfyUI_windows_portable ^(la que contiene python_embeded^).
    echo Ruta buscada: "%PY%"
    pause
    exit /b 1
)

echo.
echo === Python embebido detectado ===
"%PY%" -V
echo.

rem Asegura que pip existe dentro del embebido
"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] pip no encontrado en el embebido, instalandolo con ensurepip...
    "%PY%" -m ensurepip --upgrade
    if errorlevel 1 (
        echo [ERROR] No se pudo instalar pip en python_embeded.
        pause
        exit /b 1
    )
)

echo === Instalando/actualizando comfyui-manager ===
"%PY%" -m pip install -U --pre comfyui-manager
if errorlevel 1 (
    echo.
    echo [ERROR] La instalacion ha fallado. Revisa los mensajes de arriba.
    pause
    exit /b 1
)

echo.
echo === Verificacion ===
"%PY%" -m pip show comfyui-manager

echo.
echo [OK] Listo. Reinicia ComfyUI para aplicar los cambios.
pause
endlocal
