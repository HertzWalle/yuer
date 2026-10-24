# 从云端服务器拉取机器人记忆到本机工作区
#   .\pull-memory.ps1            # 拉最新记忆
#   .\pull-memory.ps1 -List      # 只列云端快照
#   .\pull-memory.ps1 -Snapshot  # 先让云端打快照再拉
# 原理：用 SSH 端口转发把云端 127.0.0.1:3020 映射到本机 13020，再跑 backup-pull.mjs。
param(
  [switch]$List,
  [switch]$Snapshot
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$key = Join-Path $root '.ssh\server.pem'
$known = Join-Path $root '.ssh\known_hosts'
$envFile = Join-Path $root 'cloud\bot.env'
$localPort = 13020

if (-not (Test-Path $key)) { throw "找不到私钥：$key" }
$token = (Get-Content $envFile | Where-Object { $_ -match '^BACKUP_TOKEN=' } | Select-Object -First 1)
if (-not $token) { throw "cloud\bot.env 里没有 BACKUP_TOKEN" }
$token = $token -replace '^BACKUP_TOKEN=', ''

Write-Host "[pull] 建立 SSH 隧道 127.0.0.1:$localPort → 云端 3020 ..." -ForegroundColor Cyan
$tunnel = Start-Process -FilePath 'ssh' -PassThru -WindowStyle Hidden -ArgumentList @(
  '-F', 'NUL',
  '-i', "`"$key`"",
  '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', "UserKnownHostsFile=`"$known`"",
  '-o', 'ExitOnForwardFailure=yes',
  '-N', '-L', "${localPort}:127.0.0.1:3020",
  'ubuntu@124.220.183.169'
)

try {
  # 等隧道就绪
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$localPort/health" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    if ($tunnel.HasExited) { throw "SSH 隧道已退出（exit $($tunnel.ExitCode)）" }
  }
  if (-not $ready) { throw "SSH 隧道未就绪" }

  $nodeArgs = @((Join-Path $root 'backup-pull.mjs'), '--url', "http://127.0.0.1:$localPort", '--token', $token, '--out', (Join-Path $root 'backups'))
  if ($List) { $nodeArgs += '--list' }
  if ($Snapshot) { $nodeArgs += '--snapshot' }
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}
