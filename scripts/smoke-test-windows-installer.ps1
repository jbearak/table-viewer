[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Wait-ForCondition {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [int]$TimeoutSeconds = 60
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (& $Condition) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Timed out waiting for $Description."
}

function Invoke-CheckedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [hashtable]$Environment = @(),
        [int]$TimeoutSeconds = 180
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    foreach ($argument in $ArgumentList) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        $startInfo.Environment[$entry.Key] = $entry.Value
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        Wait-ForCondition {
            $process.Refresh()
            $process.HasExited
        } "$(Split-Path -Leaf $FilePath) to exit" $TimeoutSeconds
    } catch {
        if (-not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
        throw
    }
    if ($process.ExitCode -ne 0) {
        throw "$(Split-Path -Leaf $FilePath) exited with code $($process.ExitCode)."
    }
    return $process
}

function Get-RegistryDefaultValue {
    param([Parameter(Mandatory = $true)][string]$SubKey)

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    try {
        if ($null -eq $key) {
            return $null
        }
        return $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        if ($null -ne $key) {
            $key.Dispose()
        }
    }
}

function Test-RegistryValueName {
    param(
        [Parameter(Mandatory = $true)][string]$SubKey,
        [Parameter(Mandatory = $true)][string]$ValueName
    )

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    try {
        return $null -ne $key -and $key.GetValueNames().Contains($ValueName)
    } finally {
        if ($null -ne $key) {
            $key.Dispose()
        }
    }
}

function Test-RegistryKey {
    param([Parameter(Mandatory = $true)][string]$SubKey)

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
    try {
        return $null -ne $key
    } finally {
        if ($null -ne $key) {
            $key.Dispose()
        }
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'The Windows installer smoke test must run on Windows.'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) "table-viewer-installer-smoke-$([guid]::NewGuid())"
$installDirectory = Join-Path $runRoot 'table-viewer'
$userDataDirectory = Join-Path $runRoot 'user-data'
$fixture = Join-Path $runRoot 'installer-smoke.csv'
$appExecutable = Join-Path $installDirectory 'Table Viewer.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall Table Viewer.exe'
$csvKey = 'Software\Classes\.csv'
$csvOpenWithKey = "$csvKey\OpenWithProgids"
$csvProgId = 'TableViewer.csv'
$csvProgIdKey = "Software\Classes\$csvProgId"
$csvCommandKey = "$csvProgIdKey\shell\open\command"
$originalCsvDefault = Get-RegistryDefaultValue $csvKey
$appProcess = $null
$uninstalled = $false

New-Item -ItemType Directory -Path $userDataDirectory -Force | Out-Null
Set-Content -LiteralPath (Join-Path $userDataDirectory 'settings.json') -Encoding utf8NoBOM -Value '{"automaticallyCheckForUpdates":false}'
Set-Content -LiteralPath $fixture -Encoding utf8NoBOM -Value "name,value`ninstaller,works"

try {
    Write-Host "Installing $(Split-Path -Leaf $installer) into $installDirectory"
    Invoke-CheckedProcess $installer @('/S', '/currentuser', "/D=$installDirectory") | Out-Null

    foreach ($requiredPath in @($appExecutable, $uninstaller)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Installer did not create $requiredPath."
        }
    }

    if ((Get-RegistryDefaultValue $csvKey) -ne $originalCsvDefault) {
        throw 'Installer changed the current default CSV handler.'
    }
    if (-not (Test-RegistryValueName $csvOpenWithKey $csvProgId)) {
        throw 'Installer did not add Table Viewer to the CSV Open with list.'
    }
    $expectedCommand = '"{0}" "%1"' -f $appExecutable
    if ((Get-RegistryDefaultValue $csvCommandKey) -ne $expectedCommand) {
        throw 'Installer registered an unexpected CSV open command.'
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $appExecutable
    $startInfo.UseShellExecute = $false
    [void]$startInfo.ArgumentList.Add($fixture)
    $startInfo.Environment['TABLE_VIEWER_USER_DATA_DIR'] = $userDataDirectory
    $appProcess = [System.Diagnostics.Process]::Start($startInfo)

    Wait-ForCondition {
        $appProcess.Refresh()
        -not $appProcess.HasExited -and
            $appProcess.MainWindowHandle -ne [IntPtr]::Zero -and
            $appProcess.MainWindowTitle -eq (Split-Path -Leaf $fixture)
    } 'the installed app to show the CSV viewer window'
    Wait-ForCondition {
        Test-Path -LiteralPath (Join-Path $userDataDirectory 'state\file-state.sqlite3') -PathType Leaf
    } 'the installed app to initialize its state database'

    if (-not $appProcess.CloseMainWindow()) {
        throw 'The installed app did not accept a normal window close.'
    }
    Wait-ForCondition {
        $appProcess.Refresh()
        $appProcess.HasExited
    } 'the installed app to exit cleanly'

    Write-Host "Uninstalling from $installDirectory"
    Invoke-CheckedProcess $uninstaller @('/S', '/currentuser') | Out-Null
    Wait-ForCondition {
        -not (Test-Path -LiteralPath $installDirectory)
    } 'the uninstaller to remove the installation directory'
    $uninstalled = $true

    if (Test-RegistryValueName $csvOpenWithKey $csvProgId) {
        throw 'Uninstaller left Table Viewer in the CSV Open with list.'
    }
    if (Test-RegistryKey $csvProgIdKey) {
        throw 'Uninstaller left the Table Viewer CSV ProgID behind.'
    }
    if ((Get-RegistryDefaultValue $csvKey) -ne $originalCsvDefault) {
        throw 'Uninstaller changed the current default CSV handler.'
    }

    Write-Host 'Windows installer smoke test passed.'
} finally {
    if ($null -ne $appProcess -and -not $appProcess.HasExited) {
        $appProcess.Kill($true)
        $appProcess.WaitForExit()
    }
    if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        try {
            Invoke-CheckedProcess $uninstaller @('/S', '/currentuser') | Out-Null
            Wait-ForCondition {
                -not (Test-Path -LiteralPath $installDirectory)
            } 'cleanup uninstaller to remove the installation directory'
        } catch {
            Write-Warning "Installer smoke-test cleanup failed: $_"
        }
    }
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
}
