@echo off
setlocal
title ComfyUI - recuperar los botones de limpiar cache del Manager

rem ===========================================================
rem  Devuelve a la barra de herramientas los botones que
rem  desaparecieron con el Manager 4.2.2:
rem
rem    - Unload Models            (escobita clara)
rem    - Free model and node cache (escobita rellena)
rem    - y de paso: favoritos y Share
rem
rem  Causa: el Manager crea el grupo de botones pero se dejo
rem  fuera la linea que lo inserta en la barra, asi que se
rem  construye y se descarta. No es cosa de tu instalacion.
rem
rem  SOLO aplica a la interfaz clasica del Manager
rem  (--enable-manager-legacy-ui). Con la interfaz nueva ese
rem  archivo ni se carga.
rem
rem  Coloca este .bat en la carpeta ComfyUI_windows_portable
rem  (la que contiene python_embeded) y ejecutalo con doble clic,
rem  con ComfyUI cerrado.
rem
rem  Crea una copia .bak antes de tocar nada. Si ya esta
rem  aplicado, no hace nada.
rem
rem  AVISO: el parche se pierde al actualizar comfyui-manager
rem  con pip. Si los botones vuelven a desaparecer, ejecuta
rem  este .bat otra vez.
rem ===========================================================

echo.
echo ==================================================
echo   Fix: botones de limpiar cache del Manager
echo ==================================================
echo.

set "PY=%~dp0python_embeded\python.exe"
set "OBJETIVO=%~dp0python_embeded\Lib\site-packages\comfyui_manager\js\comfyui-manager.js"

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
    echo  [ERROR] No encuentro el archivo del Manager:
    echo  %OBJETIVO%
    echo.
    echo  Puede que no tengas ComfyUI-Manager instalado via pip,
    echo  o que uses una version con otra estructura.
    echo.
    pause
    exit /b 1
)

set "TMPPY=%TEMP%\_fix_manager_cachebuttons.py"
if exist "%TMPPY%" del "%TMPPY%"

echo import io, shutil, sys>> "%TMPPY%"
echo ruta = sys.argv[1]>> "%TMPPY%"
echo ANCLA = "\t\t\t);\n\t\t}\n\t\tcatch(exception) {">> "%TMPPY%"
echo LINEA = "\n\t\t\tapp.menu?.settingsGroup.element.before(cmGroup.element);">> "%TMPPY%"
echo NUEVO = "\t\t\t);" + LINEA + "\n\t\t}\n\t\tcatch(exception) {">> "%TMPPY%"
echo t = io.open(ruta, encoding="utf-8", newline="").read()>> "%TMPPY%"
echo if "settingsGroup.element.before" in t:>> "%TMPPY%"
echo     print("  Ya estaba aplicado. No se ha tocado nada.")>> "%TMPPY%"
echo     raise SystemExit(0)>> "%TMPPY%"
echo if t.count("let cmGroup = new") != 1 or t.count(ANCLA) != 1:>> "%TMPPY%"
echo     print("  [ERROR] El archivo no coincide con lo esperado.")>> "%TMPPY%"
echo     print("  Aborto por seguridad, no se ha modificado nada.")>> "%TMPPY%"
echo     raise SystemExit(1)>> "%TMPPY%"
echo shutil.copy2(ruta, ruta + ".bak")>> "%TMPPY%"
echo io.open(ruta, "w", encoding="utf-8", newline="").write(t.replace(ANCLA, NUEVO, 1))>> "%TMPPY%"
echo print("  Parche aplicado correctamente.")>> "%TMPPY%"
echo print("  Copia de seguridad: comfyui-manager.js.bak")>> "%TMPPY%"

"%PY%" -s "%TMPPY%" "%OBJETIVO%"
set "RES=%ERRORLEVEL%"

del "%TMPPY%" 2>nul

echo.
if "%RES%"=="0" (
    echo  Arranca ComfyUI y recarga la pagina con CTRL + F5.
    echo  El navegador guarda el archivo en cache: sin recarga
    echo  forzada seguiras viendo la version antigua.
) else (
    echo  No se ha aplicado el parche. Revisa el mensaje de arriba.
)
echo.
pause
endlocal
