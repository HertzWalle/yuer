# 重新生成 QQ 小号登录二维码并直接打开图片（过期了就再跑一次）
# 用法：右键 -> 使用 PowerShell 运行；或  powershell -ExecutionPolicy Bypass -File refresh-qr.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = 'ubuntu@124.220.183.169'
$sshOpt = @(
  '-F', 'NUL',
  '-i', (Join-Path $root '.ssh\server.pem'),
  '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', ('UserKnownHostsFile=' + (Join-Path $root '.ssh\known_hosts'))
)
$py = 'C:\Users\黄志\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$png = Join-Path $root 'qrcode.png'
$big = Join-Path $root 'qrcode-big.png'

Write-Host '== 重启 NapCat，生成新的登录二维码 ==' -ForegroundColor Cyan
& ssh @sshOpt $dest 'sudo docker restart napcat >/dev/null' | Out-Null
Start-Sleep -Seconds 24

# 确认远端二维码是刚生成的（60 秒内）
$age = & ssh @sshOpt $dest 'sudo sh -c "echo $(( $(date +%s) - $(stat -c %Y /opt/napcat/cache/qrcode.png) ))"'
$age = [int]($age | Select-Object -First 1)
Write-Host ("二维码生成于 {0} 秒前" -f $age)
if ($age -gt 120) { Write-Warning '二维码看起来不是新的，稍后可以再跑一次本脚本。' }

& ssh @sshOpt $dest 'sudo cp /opt/napcat/cache/qrcode.png /tmp/qr-live.png; sudo chmod 644 /tmp/qr-live.png' | Out-Null
& scp @sshOpt "${dest}:/tmp/qr-live.png" $png | Out-Null
& $py -c "from PIL import Image; im=Image.open(r'$png'); im=im.resize((im.width*4, im.height*4), Image.NEAREST); im.save(r'$big')" | Out-Null

Write-Host '== 二维码已打开，请用「小号 2536561711」扫 ==' -ForegroundColor Green
Write-Host '有效期约 2 分钟。过期了就把本脚本再跑一次。' -ForegroundColor Yellow
Start-Process $big
