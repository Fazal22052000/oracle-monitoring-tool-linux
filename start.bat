@echo off
echo ============================================
echo   Oracle AI Dashboard - Starting Server
echo ============================================
echo.

:: Install dependencies if node_modules missing
IF NOT EXIST "node_modules" (
    echo [1/2] Installing dependencies...
    npm install express oracledb cors dotenv
    echo.
)

echo [2/2] Starting server...
echo      Dashboard: open oracle_ai_dashboard.html in your browser
echo      Backend:   http://localhost:8080
echo.
node server.js
pause
