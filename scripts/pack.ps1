# B站每日必看 · 构建产物的 zip 打包脚本
param(
  [string]$Version = "0.2.3"
)

$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root "dist"
if (-not (Test-Path $dist)) {
  Write-Error "dist 不存在，请先运行 npm run build"
  exit 1
}

$out = Join-Path $root "bili-daily-picks-v$Version.zip"
if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }
Compress-Archive -Path (Join-Path $dist "*") -DestinationPath $out -Force
Write-Output "已打包：$out"
