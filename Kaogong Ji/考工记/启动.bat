@echo off
title 考工记
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" for /f "delims=" %%i in ('where node 2^>nul') do set "NODE=%%i"
if not exist "%NODE%" (
  echo.
  echo   没找到 Node。考工记要靠 DSH 自带的 Node 跑，找不到就起不来。
  echo   找过：%USERPROFILE%\.dsh\dsh-runtimes\...\node.exe
  echo   要是 DSH 装在别处，把它的 node.exe 路径填进本文件第 4 行。
  echo.
  pause
  exit /b 1
)
"%NODE%" "%~dp0server.mjs" %*
echo.
echo 考工记已退出。
pause
