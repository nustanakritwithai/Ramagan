# RAMAGAN V1 Windows local launcher (run under restricted service account)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonExe = Join-Path $Here '.venv\Scripts\python.exe'
if (-not (Test-Path $PythonExe)) { throw 'Install dependencies first. See README.md' }
if (-not $env:RAMAGAN_DB_PATH) {
    $env:RAMAGAN_DB_PATH = 'C:\Ramagan\data\ramagan.sqlite3'
}
if (-not $env:RAMAGAN_CORS_ORIGINS) {
    $env:RAMAGAN_CORS_ORIGINS = 'https://localhost,https://nustanakritwithai.github.io'
}
Set-Location $Here
& $PythonExe -m uvicorn app:app --host 127.0.0.1 --port 8766 --workers 1
exit $LASTEXITCODE
