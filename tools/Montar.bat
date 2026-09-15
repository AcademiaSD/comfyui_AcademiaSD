@echo off
setlocal
chcp 65001 >nul
title Moviola - montar clips

echo.
echo   ================================================
echo    MOVIOLA - unir clips de un bucle
echo   ================================================
echo.
echo    Quita el fotograma repetido de cada union y
echo    superpone la cola de audio 250 ms. Corte duro.
echo.

:pedir
set "INI="
set "FIN="
set /p INI=   Numero del primer clip (ej. 598):
set /p FIN=   Numero del ultimo clip  (ej. 604):

if "%INI%"=="" goto pedir
if "%FIN%"=="" goto pedir

echo.
set "CRUDO="
set /p CRUDO=   Generar tambien la version SIN corregir para comparar? (s/N):

echo.
echo   ------------------------------------------------

REM El python empotrado de ComfyUI ya tiene todo lo necesario y evita depender
REM de que haya un Python en el PATH del sistema.
set "PY=F:\ComfyUI_windows_portable\python_embeded\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" "%~dp0montar.py" %INI% %FIN%
if errorlevel 1 goto fin

if /i "%CRUDO%"=="s" "%PY%" "%~dp0montar.py" %INI% %FIN% --sin-corregir

:fin
echo   ------------------------------------------------
echo.
pause
