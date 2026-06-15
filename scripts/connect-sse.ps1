[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$gray = "$([char]27)[90m"
$reset = "$([char]27)[0m"

while ($true) {
    curl.exe -N -s "http://localhost:3000/api/logs/stream" 2>$null | ForEach-Object {
        if ($_ -match '^data: (.+)') {
            # Format: [level] (timestamp)\nmessage — message starts on a new line
            $line = $matches[1] | jq -r --unbuffered --arg gray "$gray" --arg reset "$reset" '($gray + "[" + .level + "] (" + (.timestamp/1000 | strftime("%Y-%m-%d %H:%M:%S")) + ")" + $reset + "\n" + .message)' | Out-String
            Write-Host $line.TrimEnd()
        }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Retrying after 5 seconds..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}
