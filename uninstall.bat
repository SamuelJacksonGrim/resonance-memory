@echo off
echo.
echo   Resonance Memory - uninstall
echo   -------------------------
echo   Disconnecting from your AI apps (LM Studio / Claude Desktop)...
echo.
"%~dp0resonance-memory.exe" --uninstall
echo.
echo   Done - Resonance Memory is disconnected from your apps.
echo.
echo   Your saved memories were NOT deleted. They live here (SQLite default):
echo     "%USERPROFILE%\.lmstudio\resonance-memory.db"
echo   If you pinned JSONL (or an older install), also look for:
echo     "%USERPROFILE%\.lmstudio\resonance-memory.jsonl"
echo     (and the small .edges.json / .access.json companions beside it,
echo      plus a leftover .assoc.json if an older build wrote one.)
echo   Delete those yourself if you also want to erase your memories.
echo.
echo   You can now delete this folder to remove the program entirely.
echo.
pause
