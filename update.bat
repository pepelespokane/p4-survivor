@echo off
REM Refresh scores and kickoff times, then show what changed.
cd /d "%~dp0"
python build_schedule.py
echo.
echo Now commit and push docs\schedule.json to update the live site.
pause
