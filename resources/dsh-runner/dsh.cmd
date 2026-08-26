@echo off
setlocal EnableExtensions EnableDelayedExpansion

where npx.cmd >nul 2>nul
if %errorlevel% equ 0 (
  npx.cmd --yes --package=@deepseek-ai/dsh@latest -- dsh %*
  exit /b !errorlevel!
)

if exist "%NVM_SYMLINK%\npx.cmd" (
  "%NVM_SYMLINK%\npx.cmd" --yes --package=@deepseek-ai/dsh@latest -- dsh %*
  exit /b !errorlevel!
)

if exist "%ProgramFiles%\nodejs\npx.cmd" (
  "%ProgramFiles%\nodejs\npx.cmd" --yes --package=@deepseek-ai/dsh@latest -- dsh %*
  exit /b !errorlevel!
)

echo 未找到 npx，请先安装 Node.js。 1>&2
exit /b 127
