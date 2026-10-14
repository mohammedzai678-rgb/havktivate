@echo off
echo ========================================================
echo Starting JeevanCare Local Stack
echo ========================================================

:: Check Backend
netstat -ano | findstr :8001 | findstr LISTENING >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Backend server is already running on port 8001.
) else (
    echo [*] Starting Backend server on port 8001...
    start "JeevanCare Backend (Port 8001)" cmd /k "cd /d %~dp0server && .venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8001"
)

:: Check Frontend
netstat -ano | findstr :5173 | findstr LISTENING >nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Frontend dashboard is already running on port 5173.
) else (
    echo [*] Starting Web Dashboard on port 5173...
    start "JeevanCare Web Dashboard (Port 5173)" cmd /k "cd /d %~dp0web && npm run dev"
)

echo.
echo ========================================================
echo JeevanCare stack is ready:
echo - Web Dashboard:  http://localhost:5173
echo - Backend API:    http://localhost:8001
echo - Health Check:   http://localhost:8001/health
echo ========================================================
pause
