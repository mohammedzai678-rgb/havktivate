@echo off
echo ========================================================
echo Stopping JeevanCare Local Stack
echo ========================================================

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8001 ^| findstr LISTENING') do (
    echo Terminating backend process PID %%a on port 8001...
    taskkill /F /PID %%a
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do (
    echo Terminating frontend process PID %%a on port 5173...
    taskkill /F /PID %%a
)

echo.
echo All JeevanCare stack processes stopped.
pause
