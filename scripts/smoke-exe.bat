@echo off
cd /d "%~dp0.."
set MCP_CONSOLE_E2E_EXE=%CD%\release\MCP-Console-0.1.0-portable.exe
set MCP_CONSOLE_SMOKE_BUILTINS=1
node scripts\smoke-e2e.mjs
