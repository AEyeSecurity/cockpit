[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$ImageOverride,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$base = (Resolve-Path -LiteralPath $Manifest).Path
$revision = (& git -C $source rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$') {
    throw 'Could not resolve the Cockpit revision.'
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$compose = @('compose', '-p', 'rover-identity', '-f', $base)

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($args[0])" }
}

function Read-Label([string]$Name) {
    $container = @(Invoke-Docker inspect $Name | ConvertFrom-Json)[0]
    $label = $container.Config.Labels.PSObject.Properties['org.opencontainers.image.revision']
    if ($label) { return $label.Value }
    return $null
}

function Test-Rover {
    $address = 'http://127.0.0.1:5173'
    $page = Invoke-WebRequest "$address/" -UseBasicParsing -TimeoutSec 8
    $asset = [regex]::Match($page.Content, 'src="(/assets/[^"]+\.js)"').Groups[1].Value
    if ($page.StatusCode -ne 200 -or !$asset) { throw 'Cockpit did not serve its web bundle.' }
    $bundle = Invoke-WebRequest "$address$asset" -UseBasicParsing -TimeoutSec 8
    if ($bundle.StatusCode -ne 200 -or $bundle.Headers['Content-Type'] -notmatch 'javascript') {
        throw 'The Cockpit bundle did not load.'
    }
    $sessionStatus = & curl.exe -sS --max-time 8 -o NUL -w '%{http_code}' "$address/api/session"
    if ($LASTEXITCODE -ne 0 -or $sessionStatus -ne '401') { throw 'Cockpit did not require a session.' }
}

$settings = Invoke-Docker @compose config --format json | ConvertFrom-Json
$authEnv = $settings.services.auth.environment
$managed = [string]$authEnv.COCKPIT_ROVER_CONTROL -eq 'true'
if ($managed -and !$authEnv.COCKPIT_NAVIGATION_URL) { throw 'Managed Rover requires a private SALUS URL.' }
$passwordOnly = ([string]$authEnv.COCKPIT_PASSWORD_ONLY -eq 'true').ToString().ToLowerInvariant()
$keepConnections = (!$managed).ToString().ToLowerInvariant()
$control = $managed.ToString().ToLowerInvariant()
$variant = if ($managed) { 'managed' } else { 'direct' }
$web = "cockpit-web-pilot:${revision}-$variant"
$auth = "cockpit-auth:${revision}-$variant"
$overrideYaml = @"
services:
  web:
    image: $web
  auth:
    image: $auth
"@
if ($ValidateOnly) {
    Write-Output "Verified Compose configuration for $revision ($variant)."
    return
}

if ((Read-Label 'rover-identity-web-1') -eq $revision -and (Read-Label 'rover-identity-auth-1') -eq $revision) {
    Test-Rover
    Write-Output "Rover is already running $revision."
    return
}

Write-Output "Building Rover images for $revision ($variant) while the current deployment remains active."
Invoke-Docker build --target web-pilot --build-arg "COCKPIT_KEEP_CONNECTIONS=$keepConnections" `
    --build-arg "COCKPIT_ROVER_CONTROL=$control" --build-arg "COCKPIT_PASSWORD_ONLY=$passwordOnly" `
    --label "org.opencontainers.image.revision=$revision" -t $web $source
Invoke-Docker build --target auth --label "org.opencontainers.image.revision=$revision" -t $auth $source

$previous = if (Test-Path -LiteralPath $ImageOverride) { [IO.File]::ReadAllText($ImageOverride) } else { $null }
$candidate = "$ImageOverride.next"
[IO.File]::WriteAllText($candidate, $overrideYaml, $utf8)
try {
    Invoke-Docker @compose -f $candidate config --quiet
    Invoke-Docker @compose -f $candidate up -d --no-build --wait --wait-timeout 60 web auth
    Test-Rover
    if ((Read-Label 'rover-identity-web-1') -ne $revision -or (Read-Label 'rover-identity-auth-1') -ne $revision) {
        throw 'The two running images do not match the expected commit.'
    }
    Move-Item -LiteralPath $candidate -Destination $ImageOverride -Force
    Write-Output "Rover updated and healthy at $revision."
} catch {
    $failure = $_
    Write-Warning 'Deployment did not pass verification. Restoring the previous image pair.'
    $rollback = $compose
    if ($null -ne $previous) { $rollback += @('-f', $ImageOverride) }
    Invoke-Docker @rollback up -d --no-build --wait --wait-timeout 60 web auth
    Test-Rover
    throw $failure
} finally {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
}
