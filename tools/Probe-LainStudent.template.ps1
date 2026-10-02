param(
    [string]$ProjectPath = '',
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda',
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
if (!$ProjectPath) { $ProjectPath = Join-Path $env:USERPROFILE 'parameter-golf' }
if (!(Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw '找不到项目目录，请用 -ProjectPath 指定。' }
Get-Command wsl -ErrorAction Stop | Out-Null
function Convert-ToWslPath([string]$WindowsPath) {
    $absolutePath = [IO.Path]::GetFullPath($WindowsPath)
    if ($absolutePath -notmatch '^[A-Za-z]:\\') { throw '启动器需要本机盘符路径。' }
    return '/mnt/' + $absolutePath.Substring(0,1).ToLowerInvariant() + '/' + $absolutePath.Substring(3).Replace('\','/')
}
$payloadJson = @'
@@PAYLOAD_JSON@@
'@
$stagingPath = Join-Path ([IO.Path]::GetTempPath()) ('lain-student-probe-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stagingPath | Out-Null
    $entry = $payloadJson | ConvertFrom-Json
    if ($entry.name -ne 'student_probe.py') { throw '工具内容不合法。' }
    $destination = Join-Path $stagingPath $entry.name
    [IO.File]::WriteAllBytes($destination, [Convert]::FromBase64String($entry.base64))
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw '工具校验失败。' }
    $runnerArguments = @('--project', (Convert-ToWslPath $ProjectPath), '--device', $Device, '--install-deps')
    if ($Offline) { $runnerArguments += '--offline' }
    Write-Host '预训练学生检查：首次安装 Transformers 并下载约 1GB Qwen 权重；缓存可复用。' -ForegroundColor Cyan
    Write-Host '本次只推理并测显存。没有训练更新，没有老师 API 调用。Ctrl+C 可以停止。'
    $previousNativePreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & wsl -- /root/lain-training-venv/bin/python -u (Convert-ToWslPath $destination) @runnerArguments
        $probeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousNativePreference }
    if ($probeExitCode -ne 0) { throw "检查停止，退出码：$probeExitCode。请保留上面的报错。" }
} finally {
    if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
}
