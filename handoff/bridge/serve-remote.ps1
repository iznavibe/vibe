<#
.SYNOPSIS
  Start the whole remote-transcription chain and publish where to find it.

.DESCRIPTION
  Three processes have to be up for the phone to reach this machine:

    vibe-server   the engine
    bridge.mjs    the token gate (vibe-server has no auth of its own)
    cloudflared   the tunnel

  A quick tunnel's hostname is random and changes every time cloudflared
  starts, so the phone cannot be told it once. This publishes the current
  address to a secret GitHub Gist and the app reads it from there, which means
  a reboot fixes itself instead of stranding you with an address you cannot
  look up from outside.

  Only the address is published. The token never leaves this machine — it is
  typed into the phone once by hand. That is deliberate: the address alone is
  useless, so a leaked gist costs nothing.

  While this runs, Windows is asked not to idle-sleep. That request lasts only
  as long as this script; no power setting is changed and nothing needs undoing.
  Closing this window releases it.
#>
[CmdletBinding()]
param(
	[string]$Model = "$env:LOCALAPPDATA\github.com.thewh1teagle.vibe\ggml-large-v3.bin",
	[int]$ServerPort = 8123,
	[int]$BridgePort = 8130,
	[string]$GistId
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$stateFile = Join-Path $here 'remote-state.json'

# --- keep the machine awake, for exactly as long as we run --------------------
# SetThreadExecutionState is the same mechanism a video player uses. Scoped to
# this process, so there is no global setting to remember to put back.
Add-Type -Name Power -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
# Decimal, not hex: Windows PowerShell parses 0x80000000 as a negative Int32
# and then refuses to cast it to UInt32.
#   ES_CONTINUOUS                       = 2147483648
#   ES_CONTINUOUS | ES_SYSTEM_REQUIRED  = 2147483649
$ES_CONTINUOUS = [uint32]2147483648
$ES_KEEP_AWAKE = [uint32]2147483649
[void][Win32.Power]::SetThreadExecutionState($ES_KEEP_AWAKE)
Write-Host 'Windows will not idle-sleep while this window is open.' -ForegroundColor DarkGray

$procs = @()
function Start-Tracked {
	# Not $Args: that is an automatic variable in PowerShell, and a parameter of
	# the same name binds as null without complaining until it is used.
	param([string]$File, [string[]]$Arguments, [string]$Log)
	$p = Start-Process -FilePath $File -ArgumentList $Arguments -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -NoNewWindow -PassThru
	$script:procs += $p
	return $p
}

try {
	if (-not (Test-Path $Model)) { throw "Model not found: $Model" }

	$vibeServer = "$env:LOCALAPPDATA\vibe\vibe-server.exe"
	if (-not (Test-Path $vibeServer)) { throw "vibe-server not found: $vibeServer" }

	Write-Host "engine    : $(Split-Path $Model -Leaf)"
	Start-Tracked $vibeServer @('serve', '--port', "$ServerPort", '--exit-with-parent', 'false', $Model) (Join-Path $here 'vibe-server.log') | Out-Null

	# Wait for it rather than assuming: loading several gigabytes takes a while
	# and the bridge is useless pointed at a socket nothing is listening on.
	$ready = $false
	foreach ($i in 1..60) {
		Start-Sleep -Seconds 2
		try { if ((Invoke-WebRequest "http://127.0.0.1:$ServerPort/health" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) { $ready = $true; break } } catch {}
	}
	if (-not $ready) { throw "vibe-server did not come up on port $ServerPort" }
	Write-Host 'engine    : ready' -ForegroundColor Green

	Start-Tracked 'node' @((Join-Path $here 'bridge.mjs'), '--target', "http://127.0.0.1:$ServerPort", '--port', "$BridgePort") (Join-Path $here 'bridge.log') | Out-Null
	Start-Sleep -Seconds 2
	$token = (Get-Content (Join-Path $here 'token.txt') -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
	Write-Host 'bridge    : ready' -ForegroundColor Green

	$tunnelLog = Join-Path $here 'tunnel.log'
	Remove-Item $tunnelLog -ErrorAction SilentlyContinue
	$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
	if (-not $cf) { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
	Start-Tracked $cf @('tunnel', '--url', "http://127.0.0.1:$BridgePort", '--no-autoupdate') $tunnelLog | Out-Null

	# cloudflared prints the hostname to stderr once the tunnel is registered.
	$url = $null
	foreach ($i in 1..40) {
		Start-Sleep -Seconds 2
		$text = (Get-Content "$tunnelLog.err", $tunnelLog -ErrorAction SilentlyContinue) -join "`n"
		$m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
		if ($m.Success) { $url = $m.Value; break }
	}
	if (-not $url) { throw 'cloudflared did not report a tunnel address' }
	Write-Host "tunnel    : $url" -ForegroundColor Green

	# --- publish the address ---------------------------------------------------
	$payload = @{ url = $url; updated = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
	$body = @{ files = @{ 'vibe-tunnel.json' = @{ content = "$payload`n" } } } | ConvertTo-Json -Depth 5 -Compress
	# WriteAllText with an explicit no-BOM encoding, not Set-Content: Windows
	# PowerShell's `-Encoding utf8` emits a byte-order mark, and a BOM at the
	# front of a JSON file makes JSON.parse throw in the browser that reads it.
	$noBom = New-Object System.Text.UTF8Encoding($false)
	$tmp = Join-Path $env:TEMP 'vibe-gist-patch.json'
	[System.IO.File]::WriteAllText($tmp, $body, $noBom)

	if (-not $GistId -and (Test-Path $stateFile)) { $GistId = (Get-Content $stateFile -Raw | ConvertFrom-Json).gistId }

	if ($GistId) {
		gh api -X PATCH "gists/$GistId" --input $tmp | Out-Null
	} else {
		[System.IO.File]::WriteAllText((Join-Path $here 'vibe-tunnel.json'), "$payload`n", $noBom)
		$created = gh gist create (Join-Path $here 'vibe-tunnel.json') --desc 'vibe tunnel address' | Select-Object -Last 1
		$GistId = $created.Trim().Split('/')[-1]
	}
	[System.IO.File]::WriteAllText($stateFile, (@{ gistId = $GistId } | ConvertTo-Json), $noBom)

	$discovery = "https://api.github.com/gists/$GistId"
	Write-Host ''
	Write-Host 'Put these into the phone once. They do not change again:' -ForegroundColor Cyan
	Write-Host "  Discovery URL : $discovery"
	Write-Host "  Token         : $token"
	Write-Host ''
	Write-Host "Current address (found automatically): $url" -ForegroundColor DarkGray
	Write-Host 'Leave this window open. Ctrl+C stops everything.' -ForegroundColor DarkGray

	while ($true) { Start-Sleep -Seconds 3600 }
} finally {
	foreach ($p in $procs) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
	[void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
	Write-Host 'stopped; sleep allowed again' -ForegroundColor DarkGray
}
