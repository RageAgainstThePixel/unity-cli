# CI only (windows-11-arm): separate workflow step after Setup Unity; runs whether that step passed or failed. Locates Unity Hub.exe (known paths, Uninstall registry, shallow search). Does not modify env.
$ErrorActionPreference = 'Stop'

[Console]::Error.WriteLine('')
[Console]::Error.WriteLine('========== Unity Hub install location diagnostics (windows-11-arm) ==========')

$staticPaths = [System.Collections.Generic.List[string]]::new()
$null = $staticPaths.Add((Join-Path $env:LOCALAPPDATA 'Programs\Unity Hub\Unity Hub.exe'))
if ($env:ProgramFiles) {
    $null = $staticPaths.Add((Join-Path $env:ProgramFiles 'Unity Hub\Unity Hub.exe'))
}
$pfx86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if ($pfx86) {
    $null = $staticPaths.Add((Join-Path $pfx86 'Unity Hub\Unity Hub.exe'))
}

function Get-UnityHubExePathsFromRegistry {
    $results = [System.Collections.Generic.List[string]]::new()
    $patterns = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($pattern in $patterns) {
        Get-ItemProperty -Path $pattern -ErrorAction SilentlyContinue | ForEach-Object {
            $name = $_.DisplayName
            if (-not $name) { return }
            if ($name -ne 'Unity Hub' -and $name -notlike 'Unity Hub *') { return }
            $loc = $_.InstallLocation
            if (-not $loc) { return }
            $exe = Join-Path $loc 'Unity Hub.exe'
            if (Test-Path -LiteralPath $exe) {
                $results.Add($exe) | Out-Null
            }
        }
    }
    return $results
}

[Console]::Error.WriteLine('--- Known path probes ---')
foreach ($p in $staticPaths) {
    [Console]::Error.WriteLine(("{0} -> {1}" -f $p, (Test-Path -LiteralPath $p)))
}

[Console]::Error.WriteLine('--- Uninstall registry (Unity Hub + InstallLocation) ---')
$fromReg = @(Get-UnityHubExePathsFromRegistry)
if ($fromReg.Count -eq 0) {
    [Console]::Error.WriteLine('(none)')
} else {
    foreach ($r in $fromReg) {
        [Console]::Error.WriteLine($r)
    }
}

[Console]::Error.WriteLine('--- Shallow search for Unity Hub.exe (depth 6 under common roots) ---')
$searchRoots = [System.Collections.Generic.List[string]]::new()
foreach ($r in @($env:ProgramFiles, $pfx86, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if ([string]::IsNullOrWhiteSpace($r)) { continue }
    if (-not (Test-Path -LiteralPath $r)) { continue }
    $null = $searchRoots.Add($r)
}
$seenWalk = @{}
foreach ($root in $searchRoots) {
    try {
        Get-ChildItem -LiteralPath $root -Filter 'Unity Hub.exe' -File -Recurse -Depth 6 -ErrorAction SilentlyContinue |
            ForEach-Object {
                $f = $_.FullName
                try {
                    $n = [System.IO.Path]::GetFullPath($f)
                } catch {
                    return
                }
                if ($seenWalk.ContainsKey($n)) { return }
                $seenWalk[$n] = $true
                [Console]::Error.WriteLine($f)
            }
    } catch {
        [Console]::Error.WriteLine("(search skipped under ${root}: $($_.Exception.Message))")
    }
}
if ($seenWalk.Count -eq 0) {
    [Console]::Error.WriteLine('(no extra hits under those roots)')
}

[Console]::Error.WriteLine('========== end Unity Hub diagnostics ==========')
[Console]::Error.WriteLine('')
