#Requires -Version 5.1
<#
  appMoove 動画ダウンロード - 初回セットアップ (setup.ps1)

  setup.bat から起動されます。やること:
    1. %LOCALAPPDATA%\appMooveDL\ を作り、download.bat / download.ps1 をコピー
    2. bin\ に yt-dlp.exe(yt-dlp 公式 GitHub リリース)を取得
    3. bin\ に ffmpeg.exe / ffprobe.exe(yt-dlp/FFmpeg-Builds の Windows ビルド)を取得
    4. デスクトップにショートカットを作成
  管理者権限・PATH の変更は不要。何度実行しても安全です(既にあるものは再取得しません)。
  ダウンロードしたファイルは公式の SHA-256 チェックサムと照合します。

  オプション: -Yes  確認なしで進める / -NoPause  最後に Enter 待ちをしない

  注意: このファイルは UTF-8 (BOM 付き) で保存してください。
#>
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $Host.UI.RawUI.WindowTitle = 'appMoove 動画ダウンロード - セットアップ' } catch { }

# 古い Windows でも GitHub に HTTPS 接続できるように
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$AppRoot = Join-Path $env:LOCALAPPDATA 'appMooveDL'
$BinDir  = Join-Path $AppRoot 'bin'
$TmpDir  = Join-Path $AppRoot 'setup-tmp'

# 公式の配布元のみ (HTTPS)
$YtDlpUrl     = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
$YtDlpSumsUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS'
$FfZipName    = 'ffmpeg-master-latest-win64-gpl.zip'
$FfUrl        = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/' + $FfZipName
$FfSumsUrl    = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256'

$ShortcutName = 'appMoove ダウンロード.lnk'

function Write-Step([string]$m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host $m -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host $m -ForegroundColor Red }

function Wait-Close {
    if ($NoPause) { return }
    Write-Host ''
    [void](Read-Host 'Enter キーを押すと閉じます')
}

function Get-RemoteFile([string]$Url, [string]$OutFile) {
    if ($Url -notmatch '^https://') { throw "HTTPS 以外の URL は使いません: $Url" }
    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $curl) {
        # Windows 10/11 標準の curl.exe(進捗が表示され、速い)。リダイレクト先も HTTPS のみ許可
        & $curl --progress-bar --fail --location --proto '=https' --proto-redir '=https' --retry 3 --output $OutFile $Url
        if ($LASTEXITCODE -ne 0) { throw "ダウンロードに失敗しました (curl $LASTEXITCODE): $Url" }
    } else {
        $old = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'   # PowerShell 5.1 は進捗表示が非常に遅いため
        try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing } finally { $ProgressPreference = $old }
    }
    if (-not (Test-Path -LiteralPath $OutFile)) { throw "ダウンロードに失敗しました: $Url" }
}

# "ハッシュ  ファイル名" 形式のチェックサム一覧から、指定ファイルのハッシュを取り出す
function Get-ExpectedHash([string]$SumsFile, [string]$FileName) {
    foreach ($line in [System.IO.File]::ReadAllLines($SumsFile)) {
        $m = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
        if ($m.Success -and $m.Groups[2].Value.Trim() -eq $FileName) { return $m.Groups[1].Value.ToLowerInvariant() }
    }
    throw "チェックサム一覧に $FileName が見つかりません。"
}

function Assert-Hash([string]$File, [string]$Expected) {
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "ダウンロードしたファイルが壊れているか、公開元の更新と重なりました。もう一度 setup.bat を実行してください。($([System.IO.Path]::GetFileName($File)))"
    }
}

function Test-Tool([string]$Exe, [string[]]$Arguments) {
    if (-not (Test-Path -LiteralPath $Exe)) { return $false }
    try {
        $ErrorActionPreference = 'Continue'
        $null = & $Exe @Arguments 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Install-YtDlp {
    $exe = Join-Path $BinDir 'yt-dlp.exe'
    if (Test-Tool $exe @('--version')) {
        Write-Ok '  yt-dlp はインストール済みです(最新版への更新はダウンロード画面の起動時に自動で行います)。'
        return
    }
    $sums = Join-Path $TmpDir 'SHA2-256SUMS'
    $tmp  = Join-Path $TmpDir 'yt-dlp.exe'
    Get-RemoteFile $YtDlpSumsUrl $sums
    Get-RemoteFile $YtDlpUrl $tmp
    Assert-Hash $tmp (Get-ExpectedHash $sums 'yt-dlp.exe')
    Move-Item -LiteralPath $tmp -Destination $exe -Force
    if (-not (Test-Tool $exe @('--version'))) { throw 'yt-dlp.exe を起動できませんでした。ウイルス対策ソフトに止められていないか確認してください。' }
    Write-Ok '  yt-dlp を入れました。'
}

function Install-FFmpeg {
    $ffmpeg  = Join-Path $BinDir 'ffmpeg.exe'
    $ffprobe = Join-Path $BinDir 'ffprobe.exe'
    if ((Test-Tool $ffmpeg @('-version')) -and (Test-Tool $ffprobe @('-version'))) {
        Write-Ok '  ffmpeg / ffprobe はインストール済みです。'
        return
    }
    $sums = Join-Path $TmpDir 'checksums.sha256'
    $zip  = Join-Path $TmpDir $FfZipName
    $ext  = Join-Path $TmpDir 'ffmpeg-extract'
    Get-RemoteFile $FfSumsUrl $sums
    Write-Host '  (約 200MB あります。少し時間がかかります)'
    Get-RemoteFile $FfUrl $zip
    Assert-Hash $zip (Get-ExpectedHash $sums $FfZipName)
    if (Test-Path -LiteralPath $ext) { Remove-Item -LiteralPath $ext -Recurse -Force }
    Write-Host '  展開しています...'
    Expand-Archive -LiteralPath $zip -DestinationPath $ext -Force
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
        $found = Get-ChildItem -LiteralPath $ext -Recurse -File -Filter $name | Select-Object -First 1
        if (-not $found) { throw "$name が zip の中に見つかりませんでした。" }
        Copy-Item -LiteralPath $found.FullName -Destination (Join-Path $BinDir $name) -Force
    }
    if (-not ((Test-Tool $ffmpeg @('-version')) -and (Test-Tool $ffprobe @('-version')))) {
        throw 'ffmpeg を起動できませんでした。ウイルス対策ソフトに止められていないか確認してください。'
    }
    Write-Ok '  ffmpeg / ffprobe を入れました。'
}

function Copy-AppFiles {
    foreach ($name in @('download.bat', 'download.ps1')) {
        $src = Join-Path $PSScriptRoot $name
        if (-not (Test-Path -LiteralPath $src)) { throw "$name が見つかりません。setup.bat と同じフォルダに置いてください。" }
        $dst = Join-Path $AppRoot $name
        Copy-Item -LiteralPath $src -Destination $dst -Force
        try { Unblock-File -LiteralPath $dst } catch { }
    }
    Write-Ok "  $AppRoot にプログラムを置きました。"
}

function New-DesktopShortcut {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { throw 'デスクトップのフォルダが見つかりません。' }
    $lnk = Join-Path $desktop $ShortcutName
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath       = Join-Path $AppRoot 'download.bat'
    $sc.WorkingDirectory = $AppRoot
    $sc.IconLocation     = (Join-Path $BinDir 'yt-dlp.exe') + ',0'
    $sc.Description      = 'appMoove 用に動画をダウンロードして iCloud Drive に保存します'
    $sc.Save()
    Write-Ok "  デスクトップに「$([System.IO.Path]::GetFileNameWithoutExtension($ShortcutName))」を作りました。"
}

function Main {
    Write-Host '=============================================' -ForegroundColor Cyan
    Write-Host '  appMoove 動画ダウンロード - 初回セットアップ' -ForegroundColor Cyan
    Write-Host '=============================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host "次の場所に必要なツールを入れます: $AppRoot"
    Write-Host '  - yt-dlp(動画をダウンロードする道具)'
    Write-Host '  - ffmpeg(iPhone で再生できる形に整える道具)'
    Write-Host 'デスクトップにショートカットも作ります。管理者権限は不要です。'
    if (-not $Yes) {
        Write-Host ''
        $a = Read-Host '始めるには Enter、やめるには n を入力して Enter'
        if ($a -and $a.Trim() -match '^[nNｎＮ]') { Write-Host 'やめました。'; return }
    }

    New-Item -ItemType Directory -Force -Path $AppRoot, $BinDir, $TmpDir | Out-Null

    Write-Step '[1/4] プログラムをコピーしています'
    Copy-AppFiles
    Write-Step '[2/4] yt-dlp を準備しています'
    Install-YtDlp
    Write-Step '[3/4] ffmpeg を準備しています'
    Install-FFmpeg
    Write-Step '[4/4] デスクトップにショートカットを作っています'
    New-DesktopShortcut

    Write-Step '確認'
    $nodeOk = $false
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path -LiteralPath $p) { $node = Get-Item -LiteralPath $p }
    }
    if ($node) { $nodeOk = $true; Write-Ok '  Node.js: あり(YouTube のダウンロードに使います)' }
    else { Write-Warn '  Node.js が見つかりません。YouTube のダウンロードに必要です。README の「うまくいかないとき」を見てください。' }

    $icloud = Join-Path $env:USERPROFILE 'iCloudDrive'
    if (Test-Path -LiteralPath $icloud) { Write-Ok "  iCloud Drive: あり($icloud)" }
    else { Write-Warn '  iCloud Drive のフォルダが見つかりません。iCloud for Windows で iCloud Drive をオンにしてください(オフの間は「ダウンロード」フォルダに保存します)。' }

    Write-Host ''
    Write-Ok 'セットアップが終わりました。デスクトップの「appMoove ダウンロード」から使えます。'
}

try {
    Main
    if (Test-Path -LiteralPath $TmpDir) { Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    Wait-Close
    exit 0
} catch {
    Write-Err ''
    Write-Err ('セットアップに失敗しました: ' + $_.Exception.Message)
    Write-Err 'インターネット接続を確認して、もう一度 setup.bat を実行してください。'
    if (Test-Path -LiteralPath $TmpDir) { Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    Wait-Close
    exit 1
}
