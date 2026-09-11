@echo off
setlocal
title ComfyUI - arreglar el crash de Update All del Manager

rem ===========================================================
rem  Arregla el error que rompe "Update All" en ComfyUI-Manager:
rem
rem    AttributeError: 'NoneType' object has no attribute
rem    'content_type'
rem    en manager_security.py, reject_simple_form_post()
rem
rem  Causa: queue_batch llama internamente a update_comfyui(None)
rem  y la proteccion CSRF espera siempre una peticion HTTP real.
rem
rem  Afecta a comfyui-manager 4.2.2 (y a la rama manager-v4).
rem  Actualizar NO lo arregla: el fallo viene de fabrica.
rem
rem  Coloca este .bat en la carpeta ComfyUI_windows_portable
rem  (la que contiene python_embeded) y ejecutalo con doble clic,
rem  con ComfyUI cerrado.
rem
rem  Crea una copia de seguridad .bak antes de tocar nada.
rem  Si ya estaba parcheado, no hace nada.
rem
rem  AVISO: el parche se pierde al actualizar comfyui-manager
rem  con pip. Si vuelve el error, ejecuta este .bat otra vez.
rem ===========================================================

echo.
echo ============================================
echo   Fix: crash de Update All en ComfyUI-Manager
echo ============================================
echo.

set "PY=%~dp0python_embeded\python.exe"
set "OBJETIVO=%~dp0python_embeded\Lib\site-packages\comfyui_manager\common\manager_security.py"

if not exist "%PY%" (
    echo  [ERROR] No encuentro python_embeded\python.exe
    echo.
    echo  Coloca este .bat en la carpeta ComfyUI_windows_portable,
    echo  la misma que contiene la carpeta python_embeded.
    echo.
    pause
    exit /b 1
)

if not exist "%OBJETIVO%" (
    echo  [ERROR] No encuentro el fichero del Manager:
    echo  %OBJETIVO%
    echo.
    echo  Puede que no tengas ComfyUI-Manager instalado via pip,
    echo  o que uses una version con otra estructura.
    echo.
    pause
    exit /b 1
)

set "TMPPY=%TEMP%\_fix_manager_updateall.py"
if exist "%TMPPY%" del "%TMPPY%"

echo import io, os, shutil, sys>> "%TMPPY%"
echo ruta = sys.argv[1]>> "%TMPPY%"
echo OLD = "    if request.content_type in _SIMPLE_FORM_CONTENT_TYPES:">> "%TMPPY%"
echo NEW = "    # Internal callers pass no request: there is no HTTP request">> "%TMPPY%"
echo NEW = NEW + "\n    # to forge, so there is nothing to reject.\n">> "%TMPPY%"
echo NEW = NEW + "    if request is None:\n        return None\n\n" + OLD>> "%TMPPY%"
echo t = io.open(ruta, encoding="utf-8").read()>> "%TMPPY%"
echo if "if request is None:" in t:>> "%TMPPY%"
echo     print("  Ya estaba parcheado. No se ha tocado nada.")>> "%TMPPY%"
echo     raise SystemExit(0)>> "%TMPPY%"
echo if t.count(OLD) != 1:>> "%TMPPY%"
echo     print("  [ERROR] El fichero no coincide con lo esperado.")>> "%TMPPY%"
echo     print("  Aborto por seguridad, no se ha modificado nada.")>> "%TMPPY%"
echo     raise SystemExit(1)>> "%TMPPY%"
echo shutil.copy2(ruta, ruta + ".bak")>> "%TMPPY%"
echo io.open(ruta, "w", encoding="utf-8", newline="").write(t.replace(OLD, NEW, 1))>> "%TMPPY%"
echo print("  Parche aplicado correctamente.")>> "%TMPPY%"
echo print("  Copia de seguridad: manager_security.py.bak")>> "%TMPPY%"

"%PY%" -s "%TMPPY%" "%OBJETIVO%"
set "RES=%ERRORLEVEL%"

del "%TMPPY%" 2>nul

echo.
if "%RES%"=="0" (
    echo  Listo. Arranca ComfyUI y prueba Update All.
) else (
    echo  No se ha aplicado el parche. Revisa el mensaje de arriba.
)
echo.
pause
endlocal
