<#
    install-backend-service.ps1 - run the Ananya MIS backend (uvicorn) as a
    Windows service via NSSM, with automatic restart on crash.

    WHY: the FastAPI process occasionally exits (stale RDS pool, transient error).
    pool_pre_ping/pool_recycle (core/db.py) handle stale connections; this wrapper
    handles the process itself - NSSM restarts it within seconds, and it starts on
    boot.

    PREREQUISITES
      1. NSSM installed and on PATH (or pass -NssmPath):
             winget install NSSM            # or:  choco install nssm
         Download: https://nssm.cc/download  (unzip win64\nssm.exe somewhere on PATH)
      2. Run this script from an ELEVATED PowerShell (Run as administrator).

    USAGE
        # install + start
        powershell -ExecutionPolicy Bypass -File deploy\install-backend-service.ps1

        # custom port / name
        ... -File deploy\install-backend-service.ps1 -Port 8000 -ServiceName AnanyaMISBackend

        # remove the service
        ... -File deploy\install-backend-service.ps1 -Uninstall

    NOTE: a self-contained venv (.venv-backend) is created from
    backend\requirements_backend.txt so the service does not depend on the
    Store-Python user profile. Re-run after changing requirements to refresh it.
#>

[CmdletBinding()]
param(
    [string]$ServiceName = "AnanyaMISBackend",
    [int]   $Port        = 8000,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NssmPath    = "nssm",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        throw "Please run this script from an ELEVATED PowerShell (Run as administrator)."
    }
}

function Resolve-Nssm {
    $cmd = Get-Command $NssmPath -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "nssm not found. Install it (winget install NSSM / choco install nssm) or pass -NssmPath 'C:\path\to\nssm.exe'."
    }
    return $cmd.Source
}

Assert-Admin
$nssm = Resolve-Nssm

# ---- Uninstall ---------------------------------------------------------------
if ($Uninstall) {
    Write-Host "Stopping + removing service '$ServiceName'..." -ForegroundColor Yellow
    & $nssm stop   $ServiceName 2>$null
    & $nssm remove $ServiceName confirm
    Write-Host "Removed." -ForegroundColor Green
    return
}

# ---- Paths -------------------------------------------------------------------
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$VenvDir     = Join-Path $ProjectRoot ".venv-backend"
$VenvPython  = Join-Path $VenvDir "Scripts\python.exe"
$ReqFile     = Join-Path $ProjectRoot "backend\requirements_backend.txt"
$LogDir      = Join-Path $ProjectRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- Self-contained venv (real python.exe a service can run) -----------------
if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating venv at $VenvDir ..." -ForegroundColor Cyan
    python -m venv $VenvDir
}
Write-Host "Installing/updating backend dependencies ..." -ForegroundColor Cyan
& $VenvPython -m pip install --upgrade pip | Out-Null
if (Test-Path $ReqFile) {
    & $VenvPython -m pip install -r $ReqFile
} else {
    Write-Warning "No $ReqFile - install deps manually into $VenvDir."
}
& $VenvPython -c "import uvicorn, fastapi" 2>$null
if ($LASTEXITCODE -ne 0) { & $VenvPython -m pip install "uvicorn[standard]" fastapi }

# ---- Free the port if a dev instance is holding it ---------------------------
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $busy) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "Freed port $Port (killed PID $procId)" -ForegroundColor Yellow
    } catch {}
}

# ---- (Re)install the service -------------------------------------------------
& $nssm status $ServiceName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Service exists - reconfiguring ..." -ForegroundColor Yellow
    & $nssm stop $ServiceName 2>$null
} else {
    Write-Host "Installing service '$ServiceName' ..." -ForegroundColor Cyan
    & $nssm install $ServiceName $VenvPython
}

& $nssm set $ServiceName AppParameters "-m uvicorn main:app --host 0.0.0.0 --port $Port --app-dir backend"
& $nssm set $ServiceName AppDirectory   $ProjectRoot
& $nssm set $ServiceName DisplayName    "Ananya MIS Backend (FastAPI)"
& $nssm set $ServiceName Description     "Ananya Finance MIS dashboard API (uvicorn) with auto-restart"
& $nssm set $ServiceName Start           SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout       (Join-Path $LogDir "backend-service.out.log")
& $nssm set $ServiceName AppStderr       (Join-Path $LogDir "backend-service.err.log")
& $nssm set $ServiceName AppRotateFiles  1
& $nssm set $ServiceName AppRotateOnline 1
& $nssm set $ServiceName AppRotateBytes  10485760
& $nssm set $ServiceName AppStdoutCreationDisposition 4
& $nssm set $ServiceName AppStderrCreationDisposition 4
& $nssm set $ServiceName AppEnvironmentExtra "PYTHONUNBUFFERED=1"

# ---- Auto-restart policy -----------------------------------------------------
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 3000
& $nssm set $ServiceName AppThrottle     5000

# ---- Start + report ----------------------------------------------------------
& $nssm start $ServiceName
Start-Sleep -Seconds 4
& $nssm status $ServiceName
Write-Host ""
Write-Host "Backend service '$ServiceName' installed on port $Port." -ForegroundColor Green
Write-Host "  logs : $LogDir\backend-service.*.log"
Write-Host "  test : curl http://localhost:$Port/health"
Write-Host "  edit : nssm edit $ServiceName    |   remove: this script -Uninstall"
Write-Host ""
Write-Host "If the service cannot reach the DB or read .env, run it as your user:" -ForegroundColor DarkGray
Write-Host ("  nssm set {0} ObjectName .\{1} '<password>' ; nssm restart {0}" -f $ServiceName, $env:USERNAME) -ForegroundColor DarkGray
