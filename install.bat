@echo off
echo Installing Nexus Stream Deck plugin...

cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  echo Build failed. Make sure Node.js is installed.
  pause
  exit /b 1
)

set DEST=%APPDATA%\Elgato\StreamDeck\Plugins\com.nexus.streamdeck.sdPlugin
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy /e /i /q "com.nexus.streamdeck.sdPlugin" "%DEST%"

echo.
echo Done! Now restart Stream Deck software and drag a Nexus action onto a key.
pause
