@echo off
echo ========================================================
echo Starting HZF Inspector Studio (FastAPI + Web App)
echo ========================================================
cd /d "%~dp0\backend"

if not exist "venv" (
    echo Creating Python virtual environment...
    python -m venv venv
    call "venv\Scripts\activate.bat"
    echo Installing dependencies from requirements.txt...
    pip install -r requirements.txt
) else (
    call "venv\Scripts\activate.bat"
)

if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
    )
)

echo.
echo ========================================================
echo Open in browser: http://127.0.0.1:8000
echo ========================================================
echo.
python main.py
pause
