@echo off
rem dsh-cli: launch dsh-CLI through the official dsh CLI profile boot.
rem Equivalent to: dsh --profile dsh-cli <args>
rem   --resume: read ~/.dsh-cli/resume.txt and feed it to the TUI as
rem             DSH_CLI_RESUME_SESSION (the TUI writes the chosen session id
rem             there on /resume; see src/sessionHistory.ts).
rem Prereq: dsh CLI on PATH (npm install -g @deepseek-ai/dsh). The profile
rem         is created by `dsh plugin --profile dsh-cli add dsh-cli`
rem         under $DSH_HOME/profiles/dsh-cli (default ~/.dsh), so this
rem         launcher must NOT pin DSH_HOME.
rem NODE_ENV defaults to production: the React renderer's development build
rem records unbounded performance.measure() entries and OOMs long sessions.
rem WORKSPACE: 工作目录（默认当前目录；可用 DSH_CLI_WORKSPACE 环境变量覆盖）。
setlocal
if not defined NODE_ENV set "NODE_ENV=production"
set "WORKSPACE=%DSH_CLI_WORKSPACE%"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"
cd /d "%WORKSPACE%"

where dsh >nul 2>nul
if errorlevel 1 (
  echo [dsh-cli] 未找到 dsh CLI。请先安装：npm install -g @deepseek-ai/dsh 1>&2
  exit /b 1
)

set "ARGS="
:parse
if "%~1"=="" goto :run
if /i "%~1"=="--resume" (
  if exist "%USERPROFILE%\.dsh-cli\resume.txt" (
    set /p DSH_CLI_RESUME_SESSION=<"%USERPROFILE%\.dsh-cli\resume.txt"
  )
) else (
  set "ARGS=%ARGS% "%~1""
)
shift
goto :parse

:run
@dsh --profile dsh-cli %ARGS%
endlocal
