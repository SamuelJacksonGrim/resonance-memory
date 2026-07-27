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
echo   Your saved memories were NOT deleted. They live here:
echo     "%USERPROFILE%\.lmstudio\resonance-memory.jsonl"
echo   Delete that file yourself if you also want to erase your memories.
echo.
echo   You can now delete this folder to remove the program entirely.
echo.
pause
