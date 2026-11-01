@echo off
title Afterimage

echo.
echo ======================================
echo           AFTERIMAGE
echo ======================================
echo.

if not exist node_modules (
    echo Installing backend dependencies...
    call npm install
)

if not exist client\node_modules (
    echo Installing frontend dependencies...
    call npm install --prefix client
)

echo.
echo Starting Afterimage...
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:8787
echo.

call npm run dev

pause
