#Requires -Version 5.1
<#
  appMoove 動画ダウンロード (download.ps1)

  download.bat から起動されます:
    powershell -NoProfile -ExecutionPolicy Bypass -File download.ps1

  ツール一式は %LOCALAPPDATA%\appMooveDL\bin にある前提です(setup.bat で用意)。
  保存先は iCloud Drive の appMoove フォルダ。見つからなければ「ダウンロード」\appMoove。

  オプション(普段は使いません。動作確認用):
    -SaveDir <フォルダ>   保存先を指定する
    -NoOpenFolder         終了時に保存先フォルダを開かない
    -SkipUpdate           起動時の yt-dlp -U を省略する

  注意: このファイルは UTF-8 (BOM 付き) で保存してください。
        BOM が無いと Windows PowerShell 5.1 で日本語が文字化けします。
#>
[CmdletBinding()]
param(
    [string]$SaveDir = '',
    [switch]$NoOpenFolder,
    [switch]$SkipUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# ffprobe など外部ツールの出力(UTF-8)を正しく受け取るため
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $Host.UI.RawUI.WindowTitle = 'appMoove 動画ダウンロード' } catch { }

$AppRoot  = Join-Path $env:LOCALAPPDATA 'appMooveDL'
$BinDir   = Join-Path $AppRoot 'bin'
$WorkRoot = Join-Path $AppRoot 'work'
$YtDlp    = Join-Path $BinDir 'yt-dlp.exe'
$FFmpeg   = Join-Path $BinDir 'ffmpeg.exe'
$FFprobe  = Join-Path $BinDir 'ffprobe.exe'

# ファイル名の最大文字数(拡張子を除く)。iCloud / iPhone 側でも扱いやすい長さにする
$MaxNameLength = 80
# iCloud の無料枠 (5GB) を意識した警告ライン
$WarnFolderBytes = 3GB

# ---------------------------------------------------------------- 表示まわり

function Write-Info([string]$Message) { Write-Host $Message }
function Write-Ok([string]$Message)   { Write-Host $Message -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host $Message -ForegroundColor Yellow }
function Write-Err([string]$Message)  { Write-Host $Message -ForegroundColor Red }

function Wait-Close {
    Write-Host ''
    [void](Read-Host 'Enter キーを押すと閉じます')
}

function Format-Size([double]$Bytes) {
    if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f ($Bytes / 1KB))
}

# ---------------------------------------------------------------- 保存先

function Get-DownloadsFolder {
    try {
        $shell = New-Object -ComObject Shell.Application
        $p = $shell.Namespace('shell:Downloads').Self.Path
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    } catch { }
    return (Join-Path $env:USERPROFILE 'Downloads')
}

function Get-SaveFolder {
    if ($SaveDir) {
        return [pscustomobject]@{ Path = $SaveDir; IsICloud = $false }
    }
    # iCloud for Windows のローカルフォルダ(通常は %USERPROFILE%\iCloudDrive)
    $candidates = @(
        (Join-Path $env:USERPROFILE 'iCloudDrive'),
        (Join-Path $env:USERPROFILE 'iCloud Drive')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Container) {
            return [pscustomobject]@{ Path = (Join-Path $c 'appMoove'); IsICloud = $true }
        }
    }
    return [pscustomobject]@{ Path = (Join-Path (Get-DownloadsFolder) 'appMoove'); IsICloud = $false }
}

function Get-FolderBytes([string]$Path) {
    try {
        $sum = (Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        if ($sum) { return [double]$sum }
    } catch { }
    return 0
}

# ---------------------------------------------------------------- ファイル名

function Get-SafeFileName([string]$Name) {
    # Windows で使えない文字・制御文字を置き換え、長さを制限する
    $n = $Name -replace '[\\/:*?"<>|\x00-\x1F]', '_'
    $n = $n.Trim()
    if ($n.Length -gt $MaxNameLength) { $n = $n.Substring(0, $MaxNameLength) }
    # サロゲートペアの片割れが末尾に残らないように
    if ($n.Length -gt 0 -and [char]::IsHighSurrogate($n[$n.Length - 1])) { $n = $n.Substring(0, $n.Length - 1) }
    $n = $n.TrimEnd(' ', '.')
    if (-not $n) { $n = 'video' }
    if ($n -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$') { $n = '_' + $n }
    return $n
}

function Get-UniquePath([string]$Dir, [string]$BaseName, [string]$Ext) {
    $candidate = Join-Path $Dir ($BaseName + $Ext)
    $i = 2
    while (Test-Path -LiteralPath $candidate) {
        $candidate = Join-Path $Dir ('{0} ({1}){2}' -f $BaseName, $i, $Ext)
        $i++
    }
    return $candidate
}

# ---------------------------------------------------------------- 外部コマンド

function Find-NodeExe {
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($p in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'),
                     (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

function Find-DenoExe {
    $local = Join-Path $BinDir 'deno.exe'
    if (Test-Path -LiteralPath $local) { return $local }
    $cmd = Get-Command deno.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

# Windows の引数規則 (CommandLineToArgvW) に沿って 1 本のコマンドライン文字列にする
function ConvertTo-ArgumentString([string[]]$Arguments) {
    $parts = foreach ($a in $Arguments) {
        if ($a -eq '') { '""'; continue }
        if ($a -notmatch '[\s"]') { $a; continue }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $bs = 0
        foreach ($ch in $a.ToCharArray()) {
            if ($ch -eq [char]'\') {
                $bs++
            } elseif ($ch -eq [char]'"') {
                [void]$sb.Append([string]::new([char]'\', $bs * 2 + 1))
                [void]$sb.Append('"')
                $bs = 0
            } else {
                if ($bs -gt 0) { [void]$sb.Append([string]::new([char]'\', $bs)) }
                $bs = 0
                [void]$sb.Append($ch)
            }
        }
        if ($bs -gt 0) { [void]$sb.Append([string]::new([char]'\', $bs * 2)) }
        [void]$sb.Append('"')
        $sb.ToString()
    }
    return ($parts -join ' ')
}

# バイト列を UTF-8 として読み、ダメなら Shift_JIS(CP932) として読む
function Read-TextLoose([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return '' }
    try {
        $strict = New-Object System.Text.UTF8Encoding($false, $true)
        return $strict.GetString($bytes)
    } catch {
        return [System.Text.Encoding]::GetEncoding(932).GetString($bytes)
    }
}

# yt-dlp を実行する。画面にはそのまま進捗を出し、エラー出力だけファイルに取って原因判定に使う
function Invoke-YtDlp([string[]]$Arguments, [string]$ErrLog) {
    $argString = ConvertTo-ArgumentString $Arguments
    $p = Start-Process -FilePath $YtDlp -ArgumentList $argString -NoNewWindow -PassThru `
                       -RedirectStandardError $ErrLog
    $null = $p.Handle   # ExitCode を確実に取るため
    $p.WaitForExit()
    return $p.ExitCode
}

function Get-MediaInfo([string]$Path) {
    $ErrorActionPreference = 'Continue'
    $out = & $FFprobe -v error -show_entries 'stream=index,codec_type,codec_name,pix_fmt:stream_disposition=attached_pic' -of json -i $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $data = ($out -join "`n") | ConvertFrom-Json
    $video = $null; $audio = $null
    foreach ($s in @($data.streams)) {
        $isPic = $false
        if ($s.PSObject.Properties['disposition'] -and $s.disposition.PSObject.Properties['attached_pic']) {
            $isPic = ($s.disposition.attached_pic -eq 1)
        }
        if ($s.codec_type -eq 'video' -and -not $isPic -and -not $video) { $video = $s }
        elseif ($s.codec_type -eq 'audio' -and -not $audio) { $audio = $s }
    }
    $vcodec = $null; $pix = $null; $acodec = $null; $vIndex = $null; $aIndex = $null
    if ($video) {
        $vcodec = $video.codec_name; $vIndex = $video.index
        if ($video.PSObject.Properties['pix_fmt']) { $pix = $video.pix_fmt }
    }
    if ($audio) { $acodec = $audio.codec_name; $aIndex = $audio.index }
    return [pscustomobject]@{ VCodec = $vcodec; PixFmt = $pix; ACodec = $acodec; VIndex = $vIndex; AIndex = $aIndex }
}

function Format-MediaInfo($Info) {
    if (-not $Info) { return '(不明)' }
    $v = if ($Info.VCodec) { "映像 $($Info.VCodec) $($Info.PixFmt)" } else { '映像なし' }
    $a = if ($Info.ACodec) { "音声 $($Info.ACodec)" } else { '音声なし' }
    return "$v / $a"
}

# iPhone で確実に再生できる形 (H.264+AAC の mp4 / AAC の m4a、faststart) に整える
function Convert-ForIPhone([string]$InPath, [string]$Mode, [string]$OutDir) {
    $info = Get-MediaInfo $InPath
    if (-not $info) { throw 'PROBE_FAILED' }
    if (-not $info.VCodec -and -not $info.ACodec) { throw 'NO_STREAMS' }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($InPath)
    $ffArgs = @('-hide_banner', '-nostdin', '-loglevel', 'error', '-stats', '-y', '-i', $InPath)
    $reencode = $false

    if ($Mode -eq 'audio' -or -not $info.VCodec) {
        if (-not $info.ACodec) { throw 'NO_AUDIO' }
        if ($Mode -ne 'audio') { Write-Warn 'この URL には映像がありませんでした。音声のみ (m4a) で保存します。' }
        $ext = '.m4a'
        $ffArgs += @('-map', "0:$($info.AIndex)", '-vn', '-sn', '-dn')
        if ($info.ACodec -eq 'aac') {
            $ffArgs += @('-c:a', 'copy')
        } else {
            $reencode = $true
            $ffArgs += @('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
        }
        $expectV = $null
    } else {
        $ext = '.mp4'
        $vOk = ($info.VCodec -eq 'h264') -and (@('yuv420p', 'yuvj420p') -contains $info.PixFmt)
        $ffArgs += @('-map', "0:$($info.VIndex)")
        if ($info.ACodec) { $ffArgs += @('-map', "0:$($info.AIndex)") }
        $ffArgs += @('-sn', '-dn')
        if ($vOk) {
            $ffArgs += @('-c:v', 'copy')
        } else {
            $reencode = $true
            $ffArgs += @('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                         '-pix_fmt', 'yuv420p', '-profile:v', 'high')
        }
        if ($info.ACodec) {
            if ($info.ACodec -eq 'aac') {
                $ffArgs += @('-c:a', 'copy')
            } else {
                $reencode = $true
                $ffArgs += @('-c:a', 'aac', '-b:a', '160k', '-ac', '2')
            }
        }
        $expectV = 'h264'
    }

    $outPath = Join-Path $OutDir ($base + $ext)
    $ffArgs += @('-movflags', '+faststart', $outPath)

    if ($reencode) {
        Write-Warn ("iPhone 向けの形式ではなかったため変換します(元: {0})。動画の長さによっては時間がかかります..." -f (Format-MediaInfo $info))
    } else {
        Write-Info '仕上げ中(iPhone で再生しやすい形に整えています)...'
    }

    & $FFmpeg @ffArgs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outPath)) { throw 'FFMPEG_FAILED' }

    $check = Get-MediaInfo $outPath
    if (-not $check) { throw 'PROBE_FAILED' }
    if ($expectV -and $check.VCodec -ne 'h264') { throw 'VERIFY_FAILED' }
    if ($info.ACodec -and $check.ACodec -ne 'aac') { throw 'VERIFY_FAILED' }

    return [pscustomobject]@{ Path = $outPath; Info = $check; Reencoded = $reencode }
}

# ---------------------------------------------------------------- エラーの日本語化

function Get-ErrorHint([string]$ErrText) {
    $t = $ErrText
    $rules = @(
        @{ P = 'is not a valid URL|Unsupported URL';
           M = 'この URL には対応していないか、URL が正しくありません。ブラウザのアドレス欄から URL をそのままコピーして貼り付けてください。' },
        @{ P = 'Private video|This video is private';
           M = 'この動画は「非公開」です。投稿者以外はダウンロードできません。' },
        @{ P = 'members-only|Join this channel|available to this channel''s members';
           M = 'メンバー限定の動画のため、ダウンロードできません。' },
        @{ P = 'confirm your age|age-restricted|inappropriate for some users';
           M = '年齢制限のある動画のため、ログインなしではダウンロードできません。' },
        @{ P = 'not a bot';
           M = 'YouTube に「ロボットではないか」と判定されました。しばらく時間をおいてから試してください。' },
        @{ P = 'not available in your country|geo.?restrict|blocked it in your country';
           M = 'お住まいの地域では見られない動画です。' },
        @{ P = 'Premieres in|live event will begin|This live event|is_live|live stream';
           M = 'ライブ配信/プレミア公開の動画は、配信が終わってから試してください。' },
        @{ P = 'copyright|has been removed|account associated with this video has been terminated|Video unavailable|This video is unavailable|has been deleted';
           M = 'この動画は削除されたか、見られない状態です。' },
        @{ P = 'Requested format is not available';
           M = '選んだ画質のファイルが見つかりませんでした。別の番号(画質)で試してください。' },
        @{ P = 'JavaScript runtime|js-runtime|n challenge|nsig|Signature extraction failed|signature solving|player response|HTTP Error 403|Some formats may be missing';
           M = 'YouTube 側の仕様変更の可能性があります。いったんこの画面を閉じて開き直す(自動で yt-dlp が更新されます)か、時間をおいて試してください。' },
        @{ P = 'ffmpeg|ffprobe';
           M = 'ffmpeg が見つからないか壊れています。setup.bat をもう一度実行してください。' },
        @{ P = 'No space left|Errno 28|disk full';
           M = 'パソコンの空き容量が足りません。' },
        @{ P = 'getaddrinfo|Unable to download webpage|timed out|Connection|Temporary failure|Errno 11001|urlopen error|SSL|Remote end closed';
           M = 'インターネットにつながらないか、相手のサーバーが応答しませんでした。接続を確認して、もう一度試してください。' }
    )
    foreach ($r in $rules) {
        if ($t -match $r.P) { return $r.M }
    }
    return 'ダウンロードに失敗しました。URL が正しいか確認し、閉じて開き直して(yt-dlp が更新されます)もう一度試してください。'
}

# ---------------------------------------------------------------- 1 本ダウンロード

function Invoke-OneDownload([string]$Url, [string]$Mode, [string]$Dest, [string]$NodeExe, [string]$DenoExe) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $work = Join-Path $WorkRoot $stamp
    $outDir = Join-Path $work 'out'
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $errLog = Join-Path $work 'yt-dlp-stderr.txt'

    try {
        $common = @(
            '--ignore-config',
            '--no-playlist',
            '--windows-filenames',
            '--trim-filenames', "$MaxNameLength",
            '--ffmpeg-location', $BinDir,
            '-P', $work,
            '-o', '%(title)s.%(ext)s'
        )
        # YouTube には JavaScript ランタイムが必要 (yt-dlp 既定は deno のみ有効)
        if (-not $DenoExe -and $NodeExe) { $common += @('--js-runtimes', "node:$NodeExe") }
        elseif ($DenoExe -and $DenoExe -like "$BinDir*") { $common += @('--js-runtimes', "deno:$DenoExe") }

        switch ($Mode) {
            'audio' {
                $fmt = @('-f', 'ba[acodec^=mp4a]/ba/b', '-x', '--audio-format', 'm4a')
                $label = '音声のみ (m4a)'
            }
            'v1080' {
                $fmt = @('-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b',
                         '-S', 'res:1080', '--merge-output-format', 'mp4')
                $label = '動画 1080p (mp4)'
            }
            default {
                $fmt = @('-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b',
                         '-S', 'res:720', '--merge-output-format', 'mp4')
                $label = '動画 720p (mp4)'
            }
        }

        Write-Host ''
        Write-Info "ダウンロード開始: $label"
        $code = Invoke-YtDlp -Arguments ($common + $fmt + @('--', $Url)) -ErrLog $errLog
        $errText = Read-TextLoose $errLog

        $media = @(Get-ChildItem -LiteralPath $work -File |
                   Where-Object { $_.Extension -match '^\.(mp4|m4a|mkv|webm|mov|mp3|aac|opus|ogg|flv|3gp|wav)$' } |
                   Sort-Object Length -Descending)

        if ($code -ne 0 -or $media.Count -eq 0) {
            Write-Host ''
            Write-Err ('失敗しました: ' + (Get-ErrorHint $errText))
            $errLines = @($errText -split "`r?`n" | Where-Object { $_ -match '^(ERROR|WARNING):' } | Select-Object -Last 3)
            if ($errLines.Count -gt 0) {
                Write-Host '  (詳しい情報・英語)' -ForegroundColor DarkGray
                foreach ($l in $errLines) { Write-Host ('  ' + $l) -ForegroundColor DarkGray }
            }
            return $null
        }

        # 警告は参考に表示(失敗ではない)
        $warnLines = @($errText -split "`r?`n" | Where-Object { $_ -match '^WARNING:' } | Select-Object -Last 3)
        foreach ($l in $warnLines) { Write-Host ('  ' + $l) -ForegroundColor DarkGray }

        $src = $media[0].FullName
        try {
            $result = Convert-ForIPhone -InPath $src -Mode $Mode -OutDir $outDir
        } catch {
            Write-Err '失敗しました: ダウンロードはできましたが、iPhone 向けの形式への変換に失敗しました。'
            Write-Err '  ffmpeg が壊れている可能性があります。setup.bat をもう一度実行してください。'
            Write-Host ('  (' + $_.Exception.Message + ')') -ForegroundColor DarkGray
            return $null
        }

        New-Item -ItemType Directory -Force -Path $Dest | Out-Null
        $ext = [System.IO.Path]::GetExtension($result.Path)
        $name = Get-SafeFileName ([System.IO.Path]::GetFileNameWithoutExtension($result.Path))
        $final = Get-UniquePath -Dir $Dest -BaseName $name -Ext $ext
        Move-Item -LiteralPath $result.Path -Destination $final

        $size = (Get-Item -LiteralPath $final).Length
        Write-Host ''
        Write-Ok ('完了: ' + [System.IO.Path]::GetFileName($final))
        Write-Info ('  大きさ: {0}   形式: {1}' -f (Format-Size $size), (Format-MediaInfo $result.Info))
        return $final
    } finally {
        if ($work.StartsWith($WorkRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---------------------------------------------------------------- 入力

function Read-Url {
    Write-Host ''
    Write-Host '動画の URL を貼り付けて Enter(何も入れずに Enter で終了)' -ForegroundColor Cyan
    $raw = Read-Host 'URL'
    if ($null -eq $raw) { return '' }
    $s = $raw.Trim().Trim('"', "'", '<', '>').Trim()
    if (-not $s) { return '' }
    # 貼り付けで余計な文字が付いた場合に備えて最初の URL 部分だけ取り出す
    $m = [regex]::Match($s, 'https?://\S+')
    if ($m.Success) { return $m.Value }
    return ('INVALID:' + $s)
}

function Read-Mode {
    Write-Host '  1 = 動画 720p(おすすめ・Enter だけでもこれ)'
    Write-Host '  2 = 音声のみ'
    Write-Host '  3 = 動画 1080p(ファイルが大きくなります)'
    while ($true) {
        $c = Read-Host '番号'
        if ($null -eq $c) { return 'v720' }
        $c = $c.Trim()
        # 全角数字も受け付ける
        $c = $c.Replace([string][char]0xFF11, '1').Replace([string][char]0xFF12, '2').Replace([string][char]0xFF13, '3')
        switch ($c) {
            ''  { return 'v720' }
            '1' { return 'v720' }
            '2' { return 'audio' }
            '3' { return 'v1080' }
            default { Write-Warn '1・2・3 のどれかを入力してください。' }
        }
    }
}

# ---------------------------------------------------------------- メイン

function Main {
    Write-Host '=============================================' -ForegroundColor Cyan
    Write-Host '  appMoove 動画ダウンロード' -ForegroundColor Cyan
    Write-Host '=============================================' -ForegroundColor Cyan

    $missing = @(@($YtDlp, $FFmpeg, $FFprobe) | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) {
        Write-Err '必要なツールが見つかりません。先に setup.bat をダブルクリックして準備してください。'
        foreach ($m in $missing) { Write-Host "  見つからない: $m" -ForegroundColor DarkGray }
        Wait-Close
        return
    }

    # 古い作業フォルダが残っていたら掃除
    if (Test-Path -LiteralPath $WorkRoot) {
        Get-ChildItem -LiteralPath $WorkRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-12) } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if (-not $SkipUpdate) {
        Write-Info 'yt-dlp を最新版か確認しています...'
        & $YtDlp -U
        if ($LASTEXITCODE -ne 0) {
            Write-Warn '  yt-dlp の更新確認ができませんでした(インターネット接続を確認してください)。このまま続けます。'
        }
    }

    $node = Find-NodeExe
    $deno = Find-DenoExe
    if (-not $node -and -not $deno) {
        Write-Warn 'Node.js が見つかりません。YouTube のダウンロードに失敗することがあります(README の「うまくいかないとき」参照)。'
    }

    $save = Get-SaveFolder
    try {
        New-Item -ItemType Directory -Force -Path $save.Path | Out-Null
    } catch {
        Write-Err "保存先フォルダを作れませんでした: $($save.Path)"
        Wait-Close
        return
    }
    Write-Host ''
    if ($save.IsICloud) {
        Write-Ok "保存先: $($save.Path)(iCloud Drive)"
    } elseif ($SaveDir) {
        Write-Info "保存先: $($save.Path)"
    } else {
        Write-Warn 'iCloud Drive のフォルダが見つかりませんでした。'
        Write-Warn '  iCloud for Windows を開いて「iCloud Drive」をオンにすると、iPhone に自動で届くようになります。'
        Write-Warn "  今回は代わりにここへ保存します: $($save.Path)"
    }

    $saved = @()
    while ($true) {
        $url = Read-Url
        if (-not $url) { break }
        if ($url.StartsWith('INVALID:')) {
            Write-Warn 'URL は「https://」で始まる文字です。ブラウザのアドレス欄からコピーして貼り付けてください。'
            continue
        }
        $mode = Read-Mode
        $f = $null
        try {
            $f = Invoke-OneDownload -Url $url -Mode $mode -Dest $save.Path -NodeExe $node -DenoExe $deno
        } catch {
            Write-Err ('失敗しました: 予期しないエラーです。 ' + $_.Exception.Message)
        }
        if ($f) { $saved += $f }
        Write-Host ''
        Write-Info '続けて別の動画もダウンロードできます。'
    }

    Write-Host ''
    if ($saved.Count -gt 0) {
        Write-Ok ("今回保存したファイル: {0} 本" -f $saved.Count)
    }
    if ($save.IsICloud) {
        $total = Get-FolderBytes $save.Path
        if ($total -ge $WarnFolderBytes) {
            Write-Warn ("appMoove フォルダの合計が {0} あります。iCloud の無料枠は 5GB です。" -f (Format-Size $total))
            Write-Warn '  iPhone の appMoove に取り込み終わったファイルは、iCloud 側から消してください。'
        }
        Write-Info 'iCloud への同期が終わると、iPhone の「ファイル」アプリに表示されます。'
    }
    if (-not $NoOpenFolder) {
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $save.Path + '"') } catch { }
    }
}

try {
    Main
} catch {
    Write-Err ('予期しないエラーで止まりました: ' + $_.Exception.Message)
    Wait-Close
    exit 1
}
exit 0
