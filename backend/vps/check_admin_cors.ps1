<#
RAMAGAN Admin (GitHub Pages) -> VPS routing and CORS diagnostics.
Read-only (GET / OPTIONS); never sends credentials or changes a service.

Run from Windows VPS:
  .\check_admin_cors.ps1 -ApiBase "https://157.85.96.139/ramagan-api"

Exit: 0 = all probes PASS; 2 = FAIL/UNKNOWN.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$ApiBase,
    [string]$Origin = 'https://nustanakritwithai.github.io',
    [string]$LoopbackApi = 'http://127.0.0.1:8766'
)
$ErrorActionPreference = 'Stop'
$parsed = $null
if (-not [Uri]::TryCreate($ApiBase, [System.UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne 'https') {
    throw 'ApiBase must be a trusted HTTPS URL (without /health suffix)'
}
if ($Origin -notin @('https://nustanakritwithai.github.io', 'https://localhost')) {
    throw 'Origin must be exact Ramagan GitHub Pages or Android origin'
}
$ApiBase = $ApiBase.TrimEnd('/')
$LoopbackApi = $LoopbackApi.TrimEnd('/')

function Probe {
    param(
        [string]$Label,
        [string]$Url,
        [string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [int]$ExpectedStatus = 200,
        [string]$ExpectedOrigin = '',
        [string]$ExpectedMethod = '',
        [string]$ExpectedHeader = '',
        [bool]$CheckHealth = $false
    )
    $code = 0
    $data = ''
    $resHeaders = $null
    try {
        $res = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -UseBasicParsing -TimeoutSec 12
        $code = [int]$res.StatusCode
        $data = [string]$res.Content
        $resHeaders = $res.Headers
    } catch {
        $response = $_.Exception.Response
        if ($null -eq $response) {
            Write-Output ("{0}: UNKNOWN TLS/NETWORK — {1}" -f $Label, $_.Exception.Message)
            return $false
        }
        $code = [int]$response.StatusCode
        $resHeaders = $response.Headers
        try {
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                try { $data = $reader.ReadToEnd() }
                finally { $reader.Dispose() }
            }
        } catch { $data = '' }
    }
    if ($code -ne $ExpectedStatus) {
        Write-Output ("{0}: FAIL HTTP {1}, expected {2}" -f $Label, $code, $ExpectedStatus)
        return $false
    }
    if ($CheckHealth) {
        try {
            $body = $data | ConvertFrom-Json -ErrorAction Stop
            if ($body.status -ne 'ok') { Write-Output ("{0}: FAIL health is not ok" -f $Label); return $false }
        } catch {
            Write-Output ("{0}: FAIL health response is not expected JSON" -f $Label)
            return $false
        }
    }
    if ($ExpectedOrigin) {
        $allowedOrigin = [string]$resHeaders['Access-Control-Allow-Origin']
        if ($allowedOrigin -ne $ExpectedOrigin) {
            Write-Output ("{0}: FAIL CORS origin '{1}' expected '{2}'" -f $Label, $allowedOrigin, $ExpectedOrigin)
            return $false
        }
        if ($ExpectedMethod -and ([string]$resHeaders['Access-Control-Allow-Methods']) -notmatch ('(?i)\b' + [regex]::Escape($ExpectedMethod) + '\b')) {
            Write-Output ("{0}: FAIL CORS method {1} missing" -f $Label, $ExpectedMethod)
            return $false
        }
        if ($ExpectedHeader -and ([string]$resHeaders['Access-Control-Allow-Headers']) -notmatch ('(?i)\b' + [regex]::Escape($ExpectedHeader) + '\b')) {
            Write-Output ("{0}: FAIL CORS header {1} missing" -f $Label, $ExpectedHeader)
            return $false
        }
    }
    Write-Output ("{0}: PASS HTTP {1}" -f $Label, $code)
    return $true
}

Write-Output ("RAMAGAN Admin read-only CORS check. Origin: {0}" -f $Origin)
$local = Probe -Label 'Loopback health' -Url "$LoopbackApi/health" -CheckHealth $true
$public = Probe -Label 'Public health' -Url "$ApiBase/health" -CheckHealth $true

$loginHeaders = @{
    'Origin' = $Origin
    'Access-Control-Request-Method' = 'POST'
    'Access-Control-Request-Headers' = 'content-type'
}
$login = Probe -Label 'Chrome login JSON preflight' -Url "$ApiBase/v1/auth/login" -Method OPTIONS -Headers $loginHeaders -ExpectedOrigin $Origin -ExpectedMethod POST -ExpectedHeader 'content-type'

$reportHeaders = @{
    'Origin' = $Origin
    'Access-Control-Request-Method' = 'GET'
    'Access-Control-Request-Headers' = 'authorization'
}
$report = Probe -Label 'Chrome report bearer preflight' -Url "$ApiBase/v1/admin/sales-report" -Method OPTIONS -Headers $reportHeaders -ExpectedOrigin $Origin -ExpectedMethod GET -ExpectedHeader 'authorization'

$reject = Probe -Label 'Admin report denies anonymous access' -Url "$ApiBase/v1/admin/sales-report" -Method GET -Headers @{'Origin'=$Origin} -ExpectedStatus 401 -ExpectedOrigin $Origin

if ($local -and $public -and $login -and $report -and $reject) {
    Write-Output 'RESULT: PASS. Real browser login may be tested (no sale gate changes).'
    exit 0
}
Write-Output 'RESULT: FAIL/UNKNOWN. Inspect Caddy path routing, active FastAPI CORS origins and TLS. Do not reload blindly.'
exit 2
