# Kill all Chrome processes forcefully
$chromeProcesses = Get-Process | Where-Object {$_.Name -like "*chrome*" -or $_.Name -like "*chromedriver*"}
foreach ($proc in $chromeProcesses) {
    try {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Killed: $($proc.Name) (PID: $($proc.Id))"
    } catch {
        Write-Host "Could not kill: $($proc.Name) (PID: $($proc.Id))"
    }
}

# Remove lock files from Chrome profile
# Get Chrome user data directory from environment or use default
$chromeUserData = $env:CHROME_USER_DATA
if (-not $chromeUserData) {
    $chromeUserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
}
$profileName = $env:CHROME_PROFILE
if (-not $profileName) {
    $profileName = "Default"
}
$profilePath = Join-Path $chromeUserData $profileName
$lockFiles = @("SingletonLock", "SingletonCookie", "SingletonSocket")
foreach ($lockFile in $lockFiles) {
    $lockPath = Join-Path $profilePath $lockFile
    if (Test-Path $lockPath) {
        try {
            Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
            Write-Host "Removed lock file: $lockFile"
        } catch {
            Write-Host "Could not remove: $lockFile"
        }
    }
}

Start-Sleep -Seconds 3

# Verify no Chrome processes remain
$remaining = Get-Process | Where-Object {$_.Name -like "*chrome*"}
if ($remaining) {
    Write-Host "`nWARNING: Some Chrome processes could not be killed:"
    $remaining | Select-Object Name, Id
    Write-Host "`nPlease restart your computer to fully clear Chrome locks."
} else {
    Write-Host "`nAll Chrome processes killed. You can now run the script."
}
