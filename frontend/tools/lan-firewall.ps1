# Firewall rules for Liria's Arcade's home network mode (run elevated by
# "Allow Arcade On Home Network.bat"). Inbound, Node.js only, PRIVATE profile only:
#   TCP 6969  the Living Room page (the arcade's own port 8080 is never opened)
#   UDP 5353  mDNS, so the Mac finds lirias-arcade.local
# The arcade has its OWN rule names ("Liria's Arcade (...)"; Liria Cinema's are
# "Liria Cinema (...)" and Playlist Liria's "Playlist Liria (...)"), so adding or
# removing these never touches the other apps' rules, and the other way round. -Remove deletes only these two. Also checks the network is marked
# Private (rules for the Private profile do nothing on a Public network).
param([switch]$Remove, [int]$Port = 6969)

$ErrorActionPreference = 'Stop'
$names = @("Liria's Arcade (home network, TCP $Port)", "Liria's Arcade (home network, mDNS)")

try {
  foreach ($n in $names) { Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule }
  if ($Remove) {
    Write-Host ''
    Write-Host '  The arcade''s firewall rules are removed (Liria Cinema''s and Playlist Liria''s are left as they are).'
    exit 0
  }

  $node = (Get-Command node -ErrorAction Stop).Source
  New-NetFirewallRule -DisplayName $names[0] -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Program $node -Profile Private | Out-Null
  New-NetFirewallRule -DisplayName $names[1] -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Program $node -Profile Private | Out-Null
  Write-Host ''
  Write-Host "  Added: Node.js may receive the arcade's Living Room page (TCP $Port) and its name (UDP 5353)"
  Write-Host '  on PRIVATE (home) networks only. Public networks stay closed.'
  Write-Host "  Node.js: $node"

  # A block rule for Node.js on the Private profile wins over any allow rule.
  $blocks = Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and ($_.Profile -match 'Private|Any') }
  if ($blocks) {
    Write-Host ''
    Write-Host '  NOTE: Windows also has a rule BLOCKING Node.js on home networks' -ForegroundColor Yellow
    Write-Host '  (usually from pressing Cancel on a Windows Firewall question once):' -ForegroundColor Yellow
    $blocks | ForEach-Object { Write-Host "    $($_.DisplayName)  [$($_.Profile)]" }
    $a = Read-Host '  Turn those block rules off so the Mac can connect? (Y/N)'
    if ($a -match '^[Yy]') { $blocks | Disable-NetFirewallRule; Write-Host '  Block rules turned off.' }
  }

  # An older Node.js allow rule that includes Public networks (often from a first-run
  # Windows Firewall question) would let other people's devices reach the PIN page on
  # public Wi-Fi. Only a warning: those rules are not ours to change.
  $wide = Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and ($_.Profile -match 'Public|Any') }
  if ($wide) {
    Write-Host ''
    Write-Host '  NOTE: Windows also has rules letting Node.js in on PUBLIC networks:' -ForegroundColor Yellow
    $wide | ForEach-Object { Write-Host "    $($_.DisplayName)  [$($_.Profile)]" }
    Write-Host '  The arcade still asks for the PIN, but you may want to turn those off'
    Write-Host '  (Windows Defender Firewall > Advanced settings > Inbound Rules).'
  }

  # The network itself must be Private for these rules to apply.
  $public = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' })
  if ($public.Count -gt 0) {
    Write-Host ''
    Write-Host '  IMPORTANT: Windows treats this network as PUBLIC:' -ForegroundColor Yellow
    $public | ForEach-Object { Write-Host "    $($_.Name)  ($($_.InterfaceAlias))" }
    Write-Host '  On a Public network the Mac cannot reach the arcade. Your home network'
    Write-Host '  should be Private (Settings > Network and internet > your connection >'
    Write-Host '  Network profile type > Private network).'
    $a = Read-Host '  Mark it as Private now? Only do this for your own home network. (Y/N)'
    if ($a -match '^[Yy]') {
      $public | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private }
      Write-Host '  Done: the network is now Private.'
    } else {
      Write-Host '  Left as Public. The Mac will not get in until it is Private.'
    }
  } else {
    Write-Host '  Network profile: Private. Good.'
  }
  exit 0
} catch {
  Write-Host ''
  Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
