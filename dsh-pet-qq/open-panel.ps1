# 一键打开云端控制台：建 SSH 隧道 → 等端口通 → 用默认浏览器打开（带 token）
#   .\open-panel.ps1            正常打开（关掉这个窗口隧道就断）
#   .\open-panel.ps1 -NoBrowser 只建隧道
param(
  [switch]$NoBrowser,
  [int]$LocalPort = 3040
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$key = Join-Path $root '.ssh\server.pem'
$known = Join-Path $root '.ssh\known_hosts'
$envFile = Join-Path $root 'cloud\bot.env'
$remote = 'ubuntu@124.220.183.169'
$remotePort = 3040

if (-not (Test-Path $key)) { throw "找不到私钥：$key" }
if (-not (Test-Path $envFile)) { throw "找不到 $envFile" }

$token = (Select-String -Path $envFile -Pattern '^PANEL_TOKEN=(.+)$' | Select-Object -First 1)
if (-not $token) { throw 'cloud\bot.env 里没有 PANEL_TOKEN' }
$token = $token.Matches.Groups[1].Value.Trim()

$url = "http://127.0.0.1:$LocalPort/?token=$token"

function Test-Panel([int]$port) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Test-Panel $LocalPort) {
  Write-Host "[panel] 本地 $LocalPort 已经在转发，直接打开。" -ForegroundColor Green
} else {
  Write-Host "[panel] 建立 SSH 隧道 127.0.0.1:$LocalPort -> 云端 $remotePort ..." -ForegroundColor Cyan
  $tunnel = Start-Process -FilePath 'ssh' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-F', 'NUL',
    '-i', "`"$key`"",
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', "UserKnownHostsFile=`"$known`"",
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-N', '-L', "${LocalPort}:127.0.0.1:$remotePort",
    $remote
  )

  $ready = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 400
    if (Test-Panel $LocalPort) { $ready = $true; break }
    if ($tunnel.HasExited) {
      throw "SSH 隧道退出了（exit $($tunnel.ExitCode)）。手动试：ssh -i `"$key`" -N -L ${LocalPort}:127.0.0.1:$remotePort $remote"
    }
  }
  if (-not $ready) {
    throw "隧道没起来。手动试：ssh -i `"$key`" -N -L ${LocalPort}:127.0.0.1:$remotePort $remote"
  }
  Write-Host '[panel] 隧道已就绪。' -ForegroundColor Green
}

Write-Host ''
Write-Host "控制台： $url" -ForegroundColor Yellow
Write-Host '（关掉这个窗口隧道就断了；下次再运行一次本脚本即可）' -ForegroundColor DarkGray

if (-not $NoBrowser) { Start-Process $url }
