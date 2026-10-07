@echo off
cd /d "%~dp0.."
del /q smoke.json 2>nul
del /q trace.log 2>nul
set MCP_CONSOLE_SMOKE=%CD%\smoke.json
set MCP_CONSOLE_TRACE=%CD%\trace.log
call npx electron .
echo --- trace.log ---
type trace.log
echo --- smoke.json ---
type smoke.json
