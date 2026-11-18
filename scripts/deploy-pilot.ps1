[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$Revision,

    [Parameter(Mandatory)]
    [string]$EnvFile,

    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')]
    [string]$Project = 'cockpit-pilot',

    [ValidateRange(1024, 65535)]
    [int]$Port = 5180,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if ($Project -eq 'cockpit' -or $Port -eq 5173) {
    throw 'El piloto requiere un proyecto y puerto distintos del Cockpit actual.'
}

$root = Split-Path -Parent $PSScriptRoot
$settings = (Resolve-Path -LiteralPath $EnvFile).Path
$actual = git -C $root rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actual -cne $Revision) {
    throw 'El SHA aprobado debe coincidir con el checkout de despliegue.'
}
$dirty = git -C $root status --porcelain
if ($LASTEXITCODE -ne 0 -or ($dirty -and !$ValidateOnly)) {
    throw 'Usar un checkout de despliegue limpio.'
}

$variables = @{
    COCKPIT_PILOT_WEB_IMAGE = "cockpit-web-pilot:$Revision"
    COCKPIT_PILOT_AUTH_IMAGE = "cockpit-auth:$Revision"
    COCKPIT_PILOT_REVISION = $Revision
    COCKPIT_PILOT_PORT = "$Port"
}
$previous = @{}
foreach ($key in $variables.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $variables[$key], 'Process')
}

function Invoke-Compose {
    & docker compose --project-directory $root -p $Project --env-file $settings -f (Join-Path $root 'compose.pilot.yaml') @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose falló (código $LASTEXITCODE)." }
}

try {
    Invoke-Compose config --quiet
    if ($ValidateOnly) { return }
    Invoke-Compose build
    Invoke-Compose up -d --no-build --wait
    $address = "http://127.0.0.1:$Port"
    $web = Invoke-WebRequest -UseBasicParsing -Uri $address -TimeoutSec 10
    if ($web.StatusCode -ne 200) { throw 'Cockpit web no responde.' }
    $status = & curl.exe -sS --max-time 10 -o NUL -w '%{http_code}' "$address/api/session"
    if ($LASTEXITCODE -ne 0 -or $status -ne '401') { throw 'La API no exige sesión.' }
    Write-Output "Piloto $Revision listo en el puerto $Port."
} finally {
    foreach ($key in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
    }
}
