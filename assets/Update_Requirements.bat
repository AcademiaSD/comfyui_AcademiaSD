@echo off
setlocal
title ComfyUI - sincronizar requirements.txt

rem ===========================================================
rem  Quita el aviso de arranque:
rem    "Installed <paquete> version X is lower than the
rem     recommended version Y"
rem
rem  Coloca este .bat en la carpeta ComfyUI_windows_portable
rem  (la que contiene python_embeded) y ejecutalo con doble clic,
rem  con ComfyUI cerrado.
rem
rem  SEGURO: usa "pip install -r" SIN -U. En requirements.txt,
rem  torch/torchvision/torchaudio van sin version fija, asi que
rem  al estar ya satisfechos pip ni los mira: tu PyTorch y tu
rem  CUDA no se tocan. Esto NO es lo mismo que
rem  update\update_comfyui_and_python_dependencies.bat, que si
rem  hace --upgrade de torch y puede cambiarte la version de CUDA.
rem
rem  Se le pueden pasar argumentos a pip, por ejemplo:
rem    update_requirements.bat --dry-run
rem ===========================================================

cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PY=%ROOT%\python_embeded\python.exe"
set "REQ=%ROOT%\ComfyUI\requirements.txt"

if not exist "%PY%" (
    echo [ERROR] No se encuentra python_embeded\python.exe
    echo Coloca este .bat en la carpeta ComfyUI_windows_portable ^(la que contiene python_embeded^).
    echo Ruta buscada: "%PY%"
    goto :fin
)

if not exist "%REQ%" (
    echo [ERROR] No se encuentra ComfyUI\requirements.txt
    echo Ruta buscada: "%REQ%"
    goto :fin
)

rem El informe va incrustado al final de este .bat.
set "REPORT=%TEMP%\comfy_req_report.py"
set "SKIP="
for /f "delims=:" %%n in ('findstr /n /b /c:"###PYTHON###" "%~f0"') do set "SKIP=%%n"
if not defined SKIP (
    echo [ERROR] Este .bat esta corrupto: falta el bloque de informe.
    goto :fin
)
more +%SKIP% "%~f0" > "%REPORT%"

echo.
echo === Python embebido ===
"%PY%" -V
echo.

echo === ANTES ===
"%PY%" -s "%REPORT%" "%REQ%"
set "PENDIENTES=%ERRORLEVEL%"

if "%PENDIENTES%"=="0" (
    echo.
    echo [OK] Ya esta todo al dia. No hay nada que instalar.
    goto :fin
)

echo.
echo === Instalando ^(sin -U: torch no se toca^) ===
"%PY%" -s -m pip install %* -r "%REQ%"
if errorlevel 1 (
    echo.
    echo [ERROR] pip ha fallado. Revisa los mensajes de arriba.
    goto :fin
)

echo.
echo === DESPUES ===
"%PY%" -s "%REPORT%" "%REQ%"

echo.
echo [OK] Listo. Ya puedes abrir ComfyUI.

:fin
del "%REPORT%" >nul 2>&1
echo.
pause
endlocal
exit /b

###PYTHON###
# -*- coding: utf-8 -*-
# Informe de paquetes comfy* : instalado vs requerido.
# Devuelve como codigo de salida el numero de paquetes pendientes.

import io
import sys
from importlib.metadata import PackageNotFoundError, version

req = sys.argv[1]
pendientes = 0

for raw in io.open(req, encoding="utf-8"):
    line = raw.split("#")[0].strip()
    if "==" not in line:
        continue  # sin version fija (torch y compania): no se toca
    name, _, want = line.partition("==")
    name, want = name.strip(), want.strip()
    if not name.startswith("comfy"):
        continue
    try:
        have = version(name)
    except PackageNotFoundError:
        have = None
    except Exception:
        have = None

    # ComfyUI omite del aviso los paquetes cuya version no puede leer,
    # asi que aqui se marcan aparte en vez de ignorarlos.
    if have is None:
        estado = "sin version legible"
        marca = " ?  "
    elif have == want:
        estado = have
        marca = "[OK]"
    else:
        estado = have
        marca = "[!] "
        pendientes += 1

    print("  {} {:<32} instalado: {:<22} requerido: {}".format(
        marca, name, estado, want))

if pendientes:
    print("")
    print("  {} paquete(s) por debajo de lo que pide requirements.txt".format(pendientes))

sys.exit(pendientes)
