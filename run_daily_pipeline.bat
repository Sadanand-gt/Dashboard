@echo off
rem ── Ananya MIS — daily pipeline (invoked by Windows Task Scheduler) ─────────
rem Writes reports into the Postgres report DB (REPORT_BACKEND in .env).
rem Log: logs\pipeline_YYYY-MM-DD.log   Exit code non-zero on any failure.

cd /d "C:\Users\Ananya_Finance\ananya_mis"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i

"C:\Users\Ananya_Finance\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\python.exe" -m pipeline.daily_run >> "logs\pipeline_%TODAY%.log" 2>&1

exit /b %ERRORLEVEL%
