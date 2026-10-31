<#
Spelwacht: houdt de GPU vrij als er gegamed wordt.

Draait op de GPU-machine met de Whisper-worker en Ollama, die ook de
Regiochecker bedienen. Om de paar seconden kijkt Spelwacht of er een spel
draait. Begint er een spel, dan:
  1. stopt het de worker (python uit $WorkerMap) meteen; een lopende
     transcriptie stopt ook, dus de GPU is direct vrij;
  2. haalt het de modellen die Ollama in het geheugen heeft eruit;
  3. antwoordt het zelf op de poort van de worker: /health geeft
     { status: "paused", reason: "game", game, since }. De Regiochecker ziet
     dat, begint niets nieuws (ook geen samenvattingen via Ollama) en telt het
     afgebroken deel niet als mislukt.
Is het spel $NaSpelMinuten minuten dicht, dan stopt dat antwoord en start de
worker weer via zijn geplande taak.

Wat telt als spel (zie ZoekSpel):
  - een programma met een venster uit een spelbibliotheek ($Bibliotheken:
    Steam, Epic, GOG, Xbox-app, EA, Ubisoft, Riot) of uit $ExtraMappen;
  - een programma uit $ExtraProgrammas;
  - een programma met een venster dat de GPU langer dan $GpuSeconden zwaar voor
    3D gebruikt (meer dan $GpuDrempel procent), voor spellen van elders.
Wat in $GeenSpel staat (browsers, OBS, Wallpaper Engine, launchers), telt nooit.

Proberen zonder iets te doen:   powershell -File spelwacht.ps1 -Proef
Installeren als geplande taak:  installeer-spelwacht.ps1
Logboek: %LOCALAPPDATA%\Spelwacht\spelwacht.log
#>
[CmdletBinding()]
param(
  # Alleen laten zien wat Spelwacht ziet en zou doen.
  [switch]$Proef,
  # Alleen de functies laden (voor de tests), niet beginnen.
  [switch]$AlleenLaden
)

# ---------- instellingen ----------

$WorkerMap = 'C:\PlaudWhisperWorker'
$WorkerTaak = 'Plaud Whisper Worker'
$WorkerPoort = 8765
$OllamaUrl = 'http://127.0.0.1:11434'

$Bibliotheken = @('\steamapps\common\', '\Epic Games\', '\GOG Galaxy\Games\', '\GOG Games\', '\XboxGames\', '\EA Games\', '\Ubisoft Game Launcher\games\', '\Riot Games\')
$ExtraMappen = @()
$ExtraProgrammas = @()

# Nooit een spel, ook al gebruiken ze de GPU of staan ze in een spelmap.
$GeenSpel = @(
  'dwm.exe', 'explorer.exe', 'csrss.exe', 'TextInputHost.exe', 'SearchHost.exe', 'StartMenuExperienceHost.exe', 'ShellExperienceHost.exe', 'Widgets.exe', 'ApplicationFrameHost.exe',
  'msedge.exe', 'msedgewebview2.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe',
  'Teams.exe', 'ms-teams.exe', 'Zoom.exe', 'Discord.exe', 'Slack.exe', 'WhatsApp.exe', 'Spotify.exe', 'vlc.exe', 'mpc-hc64.exe', 'Code.exe',
  'obs64.exe', 'Photoshop.exe', 'Resolve.exe', 'Premiere Pro.exe', 'blender.exe',
  'python.exe', 'pythonw.exe', 'ollama.exe', 'ollama app.exe',
  'steam.exe', 'steamwebhelper.exe', 'steamservice.exe', 'EpicGamesLauncher.exe', 'EpicWebHelper.exe', 'GalaxyClient.exe', 'GalaxyClient Helper.exe', 'EADesktop.exe', 'EABackgroundService.exe',
  'upc.exe', 'UbisoftConnect.exe', 'RiotClientServices.exe', 'RiotClientUx.exe', 'Battle.net.exe', 'XboxPcApp.exe', 'GamingServices.exe',
  'wallpaper32.exe', 'wallpaper64.exe', 'webwallpaper32.exe', 'vrmonitor.exe', 'vrserver.exe', 'vrcompositor.exe', 'vrdashboard.exe',
  'UnityCrashHandler64.exe', 'UnityCrashHandler32.exe', 'CrashReportClient.exe', 'nvcontainer.exe', 'NVIDIA Overlay.exe', 'NVIDIA Share.exe'
)

$GpuDrempel = 40      # procent 3D-gebruik
$GpuSeconden = 20     # zo lang achter elkaar
$ElkeSeconden = 5     # zo vaak kijken
$NaSpelMinuten = 3    # zo lang dicht voordat de worker weer start

$Logboek = Join-Path $env:LOCALAPPDATA 'Spelwacht\spelwacht.log'

# ---------- logboek ----------

function Schrijf([string]$tekst) {
  $regel = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $tekst"
  Write-Host $regel
  try {
    $map = Split-Path $Logboek
    if (-not (Test-Path $map)) { New-Item -ItemType Directory -Path $map -Force | Out-Null }
    # Niet eindeloos groeien: boven 1 MB opnieuw beginnen.
    if ((Test-Path $Logboek) -and (Get-Item $Logboek).Length -gt 1MB) { Move-Item $Logboek "$Logboek.vorige" -Force }
    Add-Content -Path $Logboek -Value $regel -Encoding UTF8
  } catch { }
}

# ---------- een spel herkennen ----------

function IsGeenSpel([string]$naam) {
  return [bool]($GeenSpel | Where-Object { $_ -ieq $naam })
}

# Uit een lijst processen ({ Naam, Pad, Pid, Venster }) het eerste spel volgens
# bibliotheek, extra map of extra programma. Geeft { Naam, Reden } of $null.
function ZoekSpelInProcessen($processen) {
  foreach ($p in $processen) {
    if (-not $p.Naam -or (IsGeenSpel $p.Naam)) { continue }
    if ($ExtraProgrammas | Where-Object { $_ -ieq $p.Naam }) { return @{ Naam = $p.Naam; Reden = 'in de lijst met spellen' } }
    if (-not $p.Pad -or -not $p.Venster) { continue }
    foreach ($map in @($Bibliotheken + $ExtraMappen)) {
      if ($map -and $p.Pad.IndexOf($map, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return @{ Naam = $p.Naam; Reden = "uit $($map.Trim('\'))" } }
    }
  }
  return $null
}

# GPU: per proces het 3D-gebruik ({ pid = procent }); wie $GpuSeconden lang
# boven $GpuDrempel zit, telt als spel. $teller onthoudt sinds wanneer.
function ZoekSpelOpGpu($gebruik, $processen, $teller, [datetime]$nu) {
  foreach ($procesId in @($teller.Keys)) {
    if (-not $gebruik.ContainsKey($procesId) -or $gebruik[$procesId] -lt $GpuDrempel) { $teller.Remove($procesId) }
  }
  foreach ($procesId in $gebruik.Keys) {
    if ($gebruik[$procesId] -lt $GpuDrempel) { continue }
    $p = $processen | Where-Object { $_.Pid -eq $procesId } | Select-Object -First 1
    if (-not $p -or -not $p.Venster -or (IsGeenSpel $p.Naam)) { continue }
    if (-not $teller.ContainsKey($procesId)) { $teller[$procesId] = $nu }
    if (($nu - $teller[$procesId]).TotalSeconds -ge $GpuSeconden) { return @{ Naam = $p.Naam; Reden = "$([int]$gebruik[$procesId])% 3D op de GPU" } }
  }
  return $null
}

# De processen van nu, met pad en of ze een venster hebben.
function LeesProcessen {
  $vensters = @{}
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) { if ($p.MainWindowHandle -ne 0) { $vensters[$p.Id] = $true } }
  foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    [pscustomobject]@{ Naam = $p.Name; Pad = $p.ExecutablePath; Pid = [int]$p.ProcessId; Venster = $vensters.ContainsKey([int]$p.ProcessId); Opdracht = $p.CommandLine }
  }
}

# 3D-gebruik per proces. Via CIM, niet Get-Counter: de namen van tellers zijn
# op een Nederlandse Windows vertaald, de CIM-klasse niet.
function LeesGpu {
  $gebruik = @{}
  try {
    foreach ($m in Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop) {
      if ($m.Name -notmatch '^pid_(\d+)_.*engtype_3D$') { continue }
      $procesId = [int]$Matches[1]
      $gebruik[$procesId] = [double]($gebruik[$procesId]) + [double]$m.UtilizationPercentage
    }
  } catch { }
  return $gebruik
}

$script:GpuTeller = @{}
function ZoekSpel {
  $processen = @(LeesProcessen)
  $spel = ZoekSpelInProcessen $processen
  if ($spel) { return $spel }
  return ZoekSpelOpGpu (LeesGpu) $processen $script:GpuTeller (Get-Date)
}

# ---------- de worker en Ollama ----------

# Python uit de map van de worker (niet Spelwacht zelf, dat er ook kan staan).
function WorkerProcessen {
  LeesProcessen | Where-Object {
    $_.Pid -ne $PID -and $_.Naam -notmatch '^(powershell|pwsh)' -and
    (($_.Pad -and $_.Pad.StartsWith($WorkerMap, [StringComparison]::OrdinalIgnoreCase)) -or
     ($_.Opdracht -and $_.Opdracht.IndexOf($WorkerMap, [StringComparison]::OrdinalIgnoreCase) -ge 0))
  }
}

function StopWorker {
  foreach ($p in @(WorkerProcessen)) {
    Schrijf "  worker stoppen: $($p.Naam) ($($p.Pid))"
    # /T: ook wat de worker zelf startte.
    & taskkill.exe /PID $p.Pid /T /F 2>&1 | Out-Null
  }
}

function StartWorker {
  if (@(WorkerProcessen).Count) { Schrijf '  de worker draait al'; return }
  try {
    Start-ScheduledTask -TaskName $WorkerTaak -ErrorAction Stop
    Schrijf "  geplande taak '$WorkerTaak' gestart"
  } catch {
    Schrijf "  kon '$WorkerTaak' niet starten: $($_.Exception.Message)"
  }
}

# Modellen die Ollama nog in het geheugen heeft eruit (keep_alive 0).
function LeegOllama {
  try {
    $ps = Invoke-RestMethod -Uri "$OllamaUrl/api/ps" -TimeoutSec 5
    foreach ($m in @($ps.models)) {
      Invoke-RestMethod -Uri "$OllamaUrl/api/generate" -Method Post -ContentType 'application/json' -Body (@{ model = $m.name; keep_alive = 0 } | ConvertTo-Json -Compress) -TimeoutSec 30 | Out-Null
      Schrijf "  Ollama: $($m.name) uit het geheugen"
    }
  } catch {
    Schrijf "  Ollama niet bereikbaar ($($_.Exception.Message)); niets te legen"
  }
}

# ---------- het antwoord op de poort van de worker ----------

$script:Luisteraar = $null
$script:Spel = $null
$script:SpelSinds = $null

# Wat /health zegt zolang er gegamed wordt.
function AntwoordVoor([string]$pad) {
  if ($pad -eq '/health') {
    return @(200, (@{ status = 'paused'; reason = 'game'; game = $script:Spel.Naam; since = (Get-Date $script:SpelSinds -Format o) } | ConvertTo-Json -Compress))
  }
  return @(503, (@{ detail = 'Gepauzeerd: er draait een spel op deze machine' } | ConvertTo-Json -Compress))
}

function StartAntwoord {
  if ($script:Luisteraar) { return }
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $WorkerPoort)
    $l.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
    $l.Start()
    $script:Luisteraar = $l
    Schrijf "  antwoord op poort $WorkerPoort gestart"
  } catch {
    # De poort is nog bezet (de worker sluit net af): volgende ronde opnieuw.
    Schrijf "  poort $WorkerPoort nog bezet: $($_.Exception.Message)"
  }
}

function StopAntwoord {
  if (-not $script:Luisteraar) { return }
  try { $script:Luisteraar.Stop() } catch { }
  $script:Luisteraar = $null
  Schrijf "  antwoord op poort $WorkerPoort gestopt"
}

# Alles wat binnenkwam beantwoorden; niet blokkeren.
function BeantwoordVerzoeken {
  if (-not $script:Luisteraar) { return }
  while ($script:Luisteraar.Pending()) {
    $client = $script:Luisteraar.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 2000
      $client.SendTimeout = 2000
      $stroom = $client.GetStream()
      $lezer = New-Object System.IO.StreamReader($stroom, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $eerste = $lezer.ReadLine()
      while ($true) { $kop = $lezer.ReadLine(); if ($null -eq $kop -or $kop -eq '') { break } }
      $pad = '/'
      if ($eerste -match '^[A-Z]+ (\S+)') { $pad = ($Matches[1] -split '\?')[0] }
      $status, $json = AntwoordVoor $pad
      $tekst = [System.Text.Encoding]::UTF8.GetBytes($json)
      $reden = @{ 200 = 'OK'; 503 = 'Service Unavailable' }[$status]
      $kopBytes = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status $reden`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($tekst.Length)`r`nConnection: close`r`n`r`n")
      $stroom.Write($kopBytes, 0, $kopBytes.Length)
      $stroom.Write($tekst, 0, $tekst.Length)
      $stroom.Flush()
    } catch {
    } finally {
      $client.Close()
    }
  }
}

# ---------- de wacht ----------

function Ronde([datetime]$nu) {
  $spel = ZoekSpel
  if ($Proef) {
    if ($spel) { Schrijf "spel: $($spel.Naam) ($($spel.Reden)); zou de worker stoppen" } else { Schrijf 'geen spel' }
    return
  }
  if ($spel) {
    $script:LaatstGezien = $nu
    if (-not $script:Spel) {
      $script:Spel = $spel
      $script:SpelSinds = $nu
      Schrijf "Spel gestart: $($spel.Naam) ($($spel.Reden)). De worker gaat op pauze."
      StopWorker
      LeegOllama
    } elseif (@(WorkerProcessen).Count) {
      # Iets anders startte de worker intussen weer (zijn eigen taak).
      Schrijf 'De worker draait weer tijdens het spel; opnieuw stoppen.'
      StopWorker
    }
    StartAntwoord
  } elseif ($script:Spel -and ($nu - $script:LaatstGezien).TotalMinutes -ge $NaSpelMinuten) {
    Schrijf "Spel voorbij ($($script:Spel.Naam)). De worker start weer."
    $script:Spel = $null
    StopAntwoord
    Start-Sleep -Seconds 1
    StartWorker
  }
}

if ($AlleenLaden) { return }

Schrijf "Spelwacht gestart$(if ($Proef) { ' (proef: er gebeurt niets)' })."
while ($true) {
  try { Ronde (Get-Date) } catch { Schrijf "Fout: $($_.Exception.Message)" }
  $einde = (Get-Date).AddSeconds($ElkeSeconden)
  while ((Get-Date) -lt $einde) {
    BeantwoordVerzoeken
    Start-Sleep -Milliseconds 200
  }
}
