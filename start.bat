@echo off
echo ========================================================
echo Starting HZF Inspector Studio Backend API (FastAPI)
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
    python -m pip install -r requirements.txt --quiet
)

if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
    )
)

echo.
echo ========================================================
echo Backend API live: http://127.0.0.1:8000 (API Docs: /docs)
echo To run Frontend: open a separate terminal and run:
echo    cd frontend
echo    npm run dev
echo ========================================================
echo.
python main.py
pause
