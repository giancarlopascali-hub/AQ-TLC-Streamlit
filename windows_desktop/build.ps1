param(
    [switch]$KeepBuild
)

# Run from any directory. A fresh, isolated build prevents installed packages
# elsewhere on the PC from entering the portable release by accident.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $repo '.windows-build'
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AQ-TLC-Desktop-v1.0-Windows-x64.zip'
if (Test-Path -LiteralPath $build) { throw "Build directory already exists: $build" }
if (Test-Path -LiteralPath $zip) { throw "Release ZIP already exists: $zip" }

Push-Location $repo
try {
    py -3.11 -m venv (Join-Path $build 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python 3.11 build environment.' }
    $python = Join-Path $build 'venv\Scripts\python.exe'
    & $python -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $PSScriptRoot 'requirements-build.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
    & $python -m unittest discover -s tests -p test_windows_host.py
    if ($LASTEXITCODE -ne 0) { throw 'Windows host tests failed.' }
    & $python (Join-Path $PSScriptRoot 'stage_frontend.py') (Join-Path $build 'staged\frontend')
    if ($LASTEXITCODE -ne 0) { throw 'Frontend staging failed.' }
    & $python -m PyInstaller (Join-Path $PSScriptRoot 'AQ-TLC-Desktop.spec') --noconfirm --distpath (Join-Path $build 'dist') --workpath (Join-Path $build 'work')
    if ($LASTEXITCODE -ne 0) { throw 'Executable build failed.' }

    $appFolder = Join-Path $build 'dist\AQ-TLC-Desktop'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README-PACKAGE.txt') -Destination (Join-Path $appFolder 'README.txt')
    Compress-Archive -LiteralPath $appFolder -DestinationPath $zip -CompressionLevel Optimal
    Write-Output "Created $zip"

    if (-not $KeepBuild) {
        # The only recursive cleanup target is the build directory created
        # above. Verify its absolute path before asking Git to remove it.
        $resolvedBuild = [System.IO.Path]::GetFullPath($build)
        if ($resolvedBuild -ne (Join-Path $repo '.windows-build') -or
            -not $resolvedBuild.StartsWith($repo + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean a build path outside the repository.'
        }
        git clean -fdx -- .windows-build
        if ($LASTEXITCODE -ne 0) { throw 'Build cleanup failed.' }
    }
}
finally {
    Pop-Location
}
