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
echo   You can now delete this folder to remove the program entirely.
echo.
pause
