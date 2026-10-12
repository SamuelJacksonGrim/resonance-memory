@echo off
echo.
echo   Resonance Memory - uninstall
echo   -------------------------
echo   Disconnecting from your AI apps and removing the Desktop shortcut.
echo   Your memories are not deleted.
echo.
"%~dp0resonance-memory.exe" --uninstall-app
set ERR=%ERRORLEVEL%
echo.
if exist "%~dp0resonance-memory.exe" del /f "%~dp0resonance-memory.exe" >nul 2>&1
if exist "%~dp0resonance-memory.exe.old" del /f "%~dp0resonance-memory.exe.old" >nul 2>&1
if exist "%~dp0resonance-memory.install.json" del /f "%~dp0resonance-memory.install.json" >nul 2>&1
echo.
echo   Done. Resonance Memory is disconnected from your apps.
echo.
echo   Your saved memories were NOT deleted. They live here (SQLite default):
echo     "%USERPROFILE%\.resonance-memory\resonance-memory.db"
echo   If you pinned JSONL (or an older install), also look for:
echo     "%USERPROFILE%\.resonance-memory\resonance-memory.jsonl"
echo     (and the small .edges.json / .access.json companions beside it,
echo      plus a leftover .assoc.json if an older build wrote one.)
echo   An older build stored the same files under:
echo     "%USERPROFILE%\.lmstudio\"
echo   (copied to the new folder on first start; the original is left as a backup.)
echo   Delete those yourself if you also want to erase your memories.
echo.
echo   The Desktop shortcut is only a pointer. Deleting it does not uninstall,
echo   and deleting it is safe. The installed program file is the one that
echo   must stay put; this script removes it after disconnecting.
echo   You can now delete this folder to remove any leftover program files.
echo.
if not "%ERR%"=="0" echo   Uninstall reported a problem. Close Claude, LM Studio, and Claude Code, then run this again.
echo.
pause
