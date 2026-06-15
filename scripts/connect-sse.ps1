[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$gray = "$([char]27)[90m"
$reset = "$([char]27)[0m"

while ($true) {
    curl.exe -N -s "http://localhost:3000/api/logs/stream" 2>$null | ForEach-Object {
        if ($_ -match '^data: (.+)') {
            $line = $matches[1] | jq -r --unbuffered '"[" + .level + "] " + "(" + (.timestamp / 1000 | strftime("%Y-%m-%d %H:%M:%S")) + ") " + .message'
            if ($line -match '^(\[[^\]]+\]\s+\([^)]+\)\s+)') {
                $prefix = $matches[1]
                $message = $line.Substring($prefix.Length)
                Write-Host "${gray}${prefix}${reset}"
                Write-Host $message
            } else {
                Write-Host $line
            }
        }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Retrying after 5 seconds..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}
