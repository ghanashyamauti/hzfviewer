@echo off
echo ========================================================
echo Starting HZF Inspector Studio (FastAPI + Web App)
echo Using Virtual Environment: backend\venv
echo ========================================================
cd /d "%~dp0\backend"
call "venv\Scripts\activate.bat"
python main.py
pause
