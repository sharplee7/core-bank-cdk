
#Requires -Version 5.1
# Git Permission Guard for Windows
# powershell -ExecutionPolicy Bypass -File .\git-permission-guard.ps1

param(
    [string]$RepoPath = "."
)

$RepoPath = Resolve-Path $RepoPath -ErrorAction SilentlyContinue
if (-not $RepoPath) { Write-Host "[-] path not found" -ForegroundColor Red; exit 1 }
Push-Location $RepoPath

$null = git rev-parse --is-inside-work-tree 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[-] Not a Git repository" -ForegroundColor Red
    Pop-Location; exit 1
}

Write-Host ""
Write-Host "=== Git Permission Guard ===" -ForegroundColor White
Write-Host ""

# 1. core.fileMode false
Write-Host "[1] Setting core.fileMode = false" -ForegroundColor Cyan
git config core.fileMode false
Write-Host "    Done." -ForegroundColor Green

# 2. Fix executable permissions
Write-Host "[2] Scanning files..." -ForegroundColor Cyan

$patterns = @("*.sh", "*.bash", "*.zsh", "*.ksh", "gradlew", "mvnw", "*.pl")
$fixCount = 0

foreach ($pat in $patterns) {
    $files = git ls-files $pat 2>$null
    if (-not $files) { continue }
    foreach ($f in ($files -split "`n" | Where-Object { $_.Trim() -ne "" })) {
        $info = git ls-files -s $f 2>$null
        if ($info -and $info.StartsWith("100644")) {
            git update-index --chmod=+x $f
            Write-Host "    chmod +x: $f" -ForegroundColor Yellow
            $fixCount++
        }
    }
}

# shebang check
$allFiles = git ls-files 2>$null
if ($allFiles) {
    foreach ($f in ($allFiles -split "`n" | Where-Object { $_.Trim() -ne "" })) {
        $fp = Join-Path $RepoPath $f
        if (-not (Test-Path $fp)) { continue }
        $line1 = Get-Content $fp -TotalCount 1 -ErrorAction SilentlyContinue
        if ($line1 -and $line1.StartsWith("#!")) {
            $info = git ls-files -s $f 2>$null
            if ($info -and $info.StartsWith("100644")) {
                git update-index --chmod=+x $f
                Write-Host "    chmod +x (shebang): $f" -ForegroundColor Yellow
                $fixCount++
            }
        }
    }
}

Write-Host "    Fixed: ${fixCount} file(s)" -ForegroundColor Green

# 3. Install pre-commit hook using byte array (avoids all parsing issues)
Write-Host "[3] Installing pre-commit hook..." -ForegroundColor Cyan

$hookPath = Join-Path $RepoPath ".git\hooks\pre-commit"

$hookBytes = [System.Convert]::FromBase64String(
    "IyEvYmluL2Jhc2gKIyBHaXQgUGVybWlzc2lvbiBHdWFyZCAtIHByZS1jb21taXQgaG9vawoK" +
    "RklYRUQ9MAoKZm9yIGZpbGUgaW4gJChnaXQgZGlmZiAtLWNhY2hlZCAtLW5hbWUtb25seSk7" +
    "IGRvCiAgWyAhIC1mICIkZmlsZSIgXSAmJiBjb250aW51ZQogIE5FRURTX0VYRUM9ZmFsc2UK" +
    "ICAjIENoZWNrIGZpbGUgZXh0ZW5zaW9uCiAgY2FzZSAiJGZpbGUiIGluCiAgICAqLnNofCou" +
    "YmFzaHwqLnpzaHwqLmtzaHwqLnBsfGdyYWRsZXd8bXZudykgTkVFRFNfRVhFQz10cnVlIDs7" +
    "CiAgZXNhYwogICMgQ2hlY2sgc2hlYmFuZwogIGlmIFsgIiRORUVEU19FWEVDIiA9ICJmYWxz" +
    "ZSIgXTsgdGhlbgogICAgaGVhZCAtbjEgIiRmaWxlIiAyPi9kZXYvbnVsbCB8IGdyZXAgLXEg" +
    "J14jIScgJiYgTkVFRFNfRVhFQz10cnVlCiAgZmkKICBpZiBbICIkTkVFRFNfRVhFQyIgPSAi" +
    "dHJ1ZSIgXTsgdGhlbgogICAgbW9kZT0kKGdpdCBscy1maWxlcyAtcyAiJGZpbGUiIHwgYXdr" +
    "ICd7cHJpbnQgJDF9JykKICAgIGlmIFsgIiRtb2RlIiA9ICIxMDA2NDQiIF07IHRoZW4KICAg" +
    "ICAgZ2l0IHVwZGF0ZS1pbmRleCAtLWNobW9kPSt4ICIkZmlsZSIKICAgICAgZ2l0IGFkZCAi" +
    "JGZpbGUiCiAgICAgIGVjaG8gIltQZXJtR3VhcmRdICtYOiAkZmlsZSIKICAgICAgRklYRUQ9" +
    "JCgoRklYRUQgKyAxKSkKICAgIGZpCiAgZmkKZG9uZQoKWyAkRklYRUQgLWd0IDAgXSAmJiBl" +
    "Y2hvICJbUGVybUd1YXJkXSAkRklYRUQgZmlsZShzKSBmaXhlZC4iCmV4aXQgMAo="
)

[System.IO.File]::WriteAllBytes($hookPath, $hookBytes)
Write-Host "    Done: $hookPath" -ForegroundColor Green

# 4. Summary
Write-Host ""
Write-Host "=== Complete ===" -ForegroundColor White
Write-Host "[v] core.fileMode = false" -ForegroundColor Green
Write-Host "[v] Permissions fixed: ${fixCount} file(s)" -ForegroundColor Green
Write-Host "[v] Pre-commit hook installed" -ForegroundColor Green
Write-Host ""
if ($fixCount -gt 0) {
    Write-Host "Next: git commit -m 'fix: restore file permissions'" -ForegroundColor Gray
}
Write-Host ""

Pop-Location

