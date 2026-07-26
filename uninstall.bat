@echo off
echo.
echo   Simple Memory - uninstall
echo   -------------------------
echo   Disconnecting from your AI apps (LM Studio / Claude Desktop)...
echo.
"%~dp0memory.exe" --uninstall
echo.
echo   Done - Simple Memory is disconnected from your apps.
echo.
echo   Your saved memories were NOT deleted. They live here:
echo     "%USERPROFILE%\.lmstudio\simple-memory.jsonl"
echo   Delete that file yourself if you also want to erase your memories.
echo.
echo   You can now delete this folder to remove the program entirely.
echo.
pause
