param(
    [string]$ProjectPath = '',
    [ValidateSet('cuda','cpu')][string]$Device = 'cuda',
    [string]$CheckpointPath = '',
    [switch]$Inspect
)
$ErrorActionPreference = 'Stop'
if (!$ProjectPath) { $ProjectPath = Join-Path $env:USERPROFILE 'parameter-golf' }
if (!(Test-Path -LiteralPath (Join-Path $ProjectPath 'train_gpt.py'))) { throw '找不到 parameter-golf，请用 -ProjectPath 指定它。' }
Get-Command wsl -ErrorAction Stop | Out-Null

function Convert-ToWslPath([string]$WindowsPath) {
    $absolutePath = [IO.Path]::GetFullPath($WindowsPath)
    if ($absolutePath -notmatch '^[A-Za-z]:\\') { throw '当前启动器需要本机盘符路径。' }
    return '/mnt/' + $absolutePath.Substring(0,1).ToLowerInvariant() + '/' + $absolutePath.Substring(3).Replace('\','/')
}

# Inference tool files are written to a unique temporary directory; nothing is unpacked.
$payloadJson = @'
@@PAYLOAD_JSON@@
'@
$stagingPath = Join-Path ([IO.Path]::GetTempPath()) ('lain-gpt-probe-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stagingPath -ErrorAction Stop | Out-Null
    $payload = $payloadJson | ConvertFrom-Json
    foreach ($entry in $payload) {
        if ($entry.name -notin @('gpt_probe.py','laptop_train.py','model-source.sha256')) { throw '检查工具内容不合法。' }
        $destination = Join-Path $stagingPath $entry.name
        [IO.File]::WriteAllBytes($destination, [Convert]::FromBase64String($entry.base64))
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw '检查工具校验失败。' }
    }
    $runnerPath = Convert-ToWslPath (Join-Path $stagingPath 'gpt_probe.py')
    $projectWslPath = Convert-ToWslPath $ProjectPath
    $runnerArguments = @('--project', $projectWslPath, '--device', $Device)
    if ($CheckpointPath) { $runnerArguments += @('--checkpoint', (Convert-ToWslPath $CheckpointPath)) }
    if ($Inspect) { $runnerArguments += '--inspect' }
    Write-Host '检查现有语言 GPT：不训练、不调用 API、不修改 Obsidian。Ctrl+C 可以停止。' -ForegroundColor Cyan
    $previousNativePreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & wsl -- /root/lain-training-venv/bin/python -u $runnerPath @runnerArguments
        $probeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousNativePreference }
    if ($probeExitCode -ne 0) { throw "检查停止，退出码：$probeExitCode。请保留上面的报错。" }
} finally {
    if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
}
