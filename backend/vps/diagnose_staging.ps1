<#
 Read-only Caddy/FastAPI routing UAT helper for Windows PowerShell.
 Examples:
 powershell -NoProfile -File .\diagnose_staging.ps1 -PublicApiBase "https://157.85.96.139/ramagan-api"
 Never bypass TLS or put authentication credentials in this script.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$PublicApiBase,
    [string]$LoopbackApiBase = "http://127.0.0.1:8766"
)
$ErrorActionPreference = 'Stop'
if (-not $PublicApiBase.StartsWith('https://')) {
    throw "PublicApiBase MUST be HTTPS with a valid certificate"
}
$PublicApiBase = $PublicApiBase.TrimEnd('/')
$LoopbackApiBase = $LoopbackApiBase.TrimEnd('/')

function Test-Endpoint {
    param(
        [string]$Label,
        [string]$Endpoint,
        [int]$ExpectedStatus,
        [bool]$RequireHealth
    )
    $code = 0
    $body = ""
    try {
        $response = Invoke-WebRequest -Uri $Endpoint -UseBasicParsing -TimeoutSec 10
        $code = [int]$response.StatusCode
        $body = [string]$response.Content
    } catch {
        $serverResponse = $_.Exception.Response
        if ($null -eq $serverResponse) {
            Write-Output ("{0}: UNKNOWN network/TLS failure. {1}" -f $Label, $_.Exception.Message)
            return $false
        }
        $code = [int]$serverResponse.StatusCode
        try {
            $stream = $serverResponse.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                try { $body = $reader.ReadToEnd() }
                finally { $reader.Dispose() }
            }
        } catch { $body = "" }
    }
    if ($code -ne $ExpectedStatus) {
        Write-Output ("{0}: FAIL HTTP {1}, expected {2}. Response: {3}" -f $Label, $code, $ExpectedStatus, $body.Substring(0, [Math]::Min($body.Length, 160)))
        return $false
    }
    if ($RequireHealth) {
        try {
            $result = $body | ConvertFrom-Json -ErrorAction Stop
            if ($result.status -ne "ok") {
                Write-Output ("{0}: FAIL JSON did not contain status=ok" -f $Label)
                return $false
            }
        } catch {
            Write-Output ("{0}: FAIL expected JSON health response, received different content" -f $Label)
            return $false
        }
    }
    Write-Output ("{0}: PASS HTTP {1}" -f $Label, $code)
    return $true
}

$local = Test-Endpoint -Label "loopback /health" -Endpoint "$LoopbackApiBase/health" -ExpectedStatus 200 -RequireHealth $true
$public = Test-Endpoint -Label "public /ramagan-api/health" -Endpoint "$PublicApiBase/health" -ExpectedStatus 200 -RequireHealth $true
$unauth = Test-Endpoint -Label "public /ramagan-api/v1/me (no token)" -Endpoint "$PublicApiBase/v1/me" -ExpectedStatus 401 -RequireHealth $false

if ($local -and $public -and $unauth) {
    Write-Output "ROUTING CHECK: PASS (Android login may now be tested independently)"
    exit 0
}
Write-Output "ROUTING CHECK: FAIL/UNKNOWN (do not reload blindly; inspect Caddy route and service)"
exit 2
