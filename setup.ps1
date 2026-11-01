# Einrichtung des Bring!-Connectors auf Cloudflare.
# Aufruf:  powershell -ExecutionPolicy Bypass -File setup.ps1
# Erneut ausfuehren erzeugt eine neue geheime URL (die alte wird ungueltig).

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
# Damit Umlaute/Sonderzeichen im Passwort korrekt an wrangler gehen
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

Write-Host "Installiere wrangler ..."
npm install --silent
if ($LASTEXITCODE -ne 0) { throw "npm install fehlgeschlagen" }

$who = npx wrangler whoami | Out-String
if ($LASTEXITCODE -ne 0 -or $who -match "not authenticated") {
    Write-Host "Bitte im Browser bei Cloudflare anmelden ..."
    npx wrangler login
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare-Login fehlgeschlagen" }
}

Write-Host "Deploye Worker ..."
$deploy = npx wrangler deploy | Out-String
Write-Host $deploy
if ($LASTEXITCODE -ne 0) { throw "Deploy fehlgeschlagen" }
$baseUrl = [regex]::Match($deploy, "https://[\w.-]+\.workers\.dev").Value

$email = Read-Host "Bring!-E-Mail"
$secure = Read-Host "Bring!-Passwort" -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString("x2") })

$email | npx wrangler secret put BRING_EMAIL
$password | npx wrangler secret put BRING_PASSWORD
$token | npx wrangler secret put MCP_TOKEN
$password = $null

Write-Host ""
Write-Host "Fertig. Diese URL in claude.ai unter Einstellungen > Connectors > Benutzerdefinierten Connector hinzufuegen:" -ForegroundColor Green
Write-Host "$baseUrl/mcp/$token" -ForegroundColor Yellow
Write-Host "Die URL ist dein Schluessel - nicht weitergeben."
