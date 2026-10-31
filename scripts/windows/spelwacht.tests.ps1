# Tests voor spelwacht.ps1, zonder Windows: de herkenning van spellen met
# nagemaakte processen en GPU-metingen, en het antwoord op de poort van de
# worker. Draaien (ook op Linux, met de PowerShell-container):
#   docker run --rm -v "$PWD/scripts/windows:/s" mcr.microsoft.com/powershell pwsh -File /s/spelwacht.tests.ps1

$ErrorActionPreference = 'Stop'
$fouten = 0
function Moet($naam, $waar) {
  if ($waar) { Write-Host "ok   $naam" } else { Write-Host "FOUT $naam"; $script:fouten++ }
}

# Beide scripts moeten foutloos te lezen zijn.
foreach ($f in 'spelwacht.ps1', 'installeer-spelwacht.ps1') {
  $fout = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $f), [ref]$null, [ref]$fout) | Out-Null
  Moet "$f is geldige PowerShell" (-not $fout -or $fout.Count -eq 0)
}

$env:LOCALAPPDATA = [IO.Path]::GetTempPath()
. (Join-Path $PSScriptRoot 'spelwacht.ps1') -AlleenLaden

$p = { param($naam, $pad, $procesId, $venster) [pscustomobject]@{ Naam = $naam; Pad = $pad; Pid = $procesId; Venster = $venster } }

# Spelbibliotheken: met venster een spel, launchers en achtergrondhulpjes niet.
$lijst = @(
  (& $p 'steam.exe' 'C:\Program Files (x86)\Steam\steam.exe' 10 $true),
  (& $p 'wallpaper64.exe' 'D:\SteamLibrary\steamapps\common\wallpaper_engine\wallpaper64.exe' 11 $true),
  (& $p 'helper.exe' 'D:\SteamLibrary\steamapps\common\Spel\helper.exe' 12 $false)
)
Moet 'launcher, Wallpaper Engine en hulpje zonder venster zijn geen spel' ($null -eq (ZoekSpelInProcessen $lijst))
$spel = ZoekSpelInProcessen ($lijst + (& $p 'Cyberpunk2077.exe' 'D:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\Cyberpunk2077.exe' 13 $true))
Moet 'een Steam-spel met venster' ($spel.Naam -eq 'Cyberpunk2077.exe' -and $spel.Reden -eq 'uit steamapps\common')
Moet 'Xbox-app (XboxGames)' ((ZoekSpelInProcessen @(& $p 'Forza.exe' 'C:\XboxGames\Forza Horizon 5\Content\Forza.exe' 14 $true)).Naam -eq 'Forza.exe')
Moet 'hoofdletters in het pad tellen niet' ($null -ne (ZoekSpelInProcessen @(& $p 'Spel.exe' 'D:\EPIC GAMES\Spel\Spel.exe' 15 $true)))
$ExtraProgrammas = @('mijnspel.exe')
Moet 'een extra programma, ook zonder venster' ((ZoekSpelInProcessen @(& $p 'MijnSpel.exe' 'C:\Elders\MijnSpel.exe' 16 $false)).Naam -eq 'MijnSpel.exe')
$ExtraProgrammas = @()

# GPU: pas na $GpuSeconden boven de drempel, alleen met venster, niet de browser.
$teller = @{}
$t0 = [datetime]'2026-10-31T18:00:00'
$procs = @((& $p 'Spel.exe' 'E:\Spellen\Spel.exe' 20 $true), (& $p 'chrome.exe' 'C:\chrome.exe' 21 $true), (& $p 'render.exe' 'C:\render.exe' 22 $false))
$gebruik = @{ 20 = 85; 21 = 90; 22 = 99 }
Moet 'GPU: nog niet na 0 s' ($null -eq (ZoekSpelOpGpu $gebruik $procs $teller $t0))
Moet 'GPU: nog niet na 10 s' ($null -eq (ZoekSpelOpGpu $gebruik $procs $teller $t0.AddSeconds(10)))
$gpu = ZoekSpelOpGpu $gebruik $procs $teller $t0.AddSeconds(20)
Moet 'GPU: na 20 s een spel (niet chrome, niet zonder venster)' ($gpu.Naam -eq 'Spel.exe' -and $gpu.Reden -eq '85% 3D op de GPU')
Moet 'GPU: zakt het gebruik, dan begint het tellen opnieuw' ($null -eq (ZoekSpelOpGpu @{ 20 = 10 } $procs $teller $t0.AddSeconds(25)) -and -not $teller.ContainsKey(20))

# Het antwoord op de poort van de worker, met een echte HTTP-client.
$WorkerPoort = 18765
$script:Spel = @{ Naam = 'Cyberpunk2077.exe'; Reden = 'test' }
$script:SpelSinds = [datetime]'2026-10-31T18:00:00'
StartAntwoord
$client = [System.Net.Http.HttpClient]::new()
$health = $client.GetAsync("http://127.0.0.1:$WorkerPoort/health")
$post = $client.PostAsync("http://127.0.0.1:$WorkerPoort/v1/media/transcriptions", [System.Net.Http.StringContent]::new('x'))
$einde = (Get-Date).AddSeconds(10)
while (-not ($health.IsCompleted -and $post.IsCompleted) -and (Get-Date) -lt $einde) { BeantwoordVerzoeken; Start-Sleep -Milliseconds 50 }
$h = $health.Result
$ruw = $h.Content.ReadAsStringAsync().Result
Write-Host "     /health gaf: $ruw"
# Op de ruwe tekst: ConvertFrom-Json maakt in PowerShell 7 van een datum een DateTime.
$json = $ruw | ConvertFrom-Json
Moet '/health: 200 met status paused, reason game en het spel' ([int]$h.StatusCode -eq 200 -and $json.status -eq 'paused' -and $json.reason -eq 'game' -and $json.game -eq 'Cyberpunk2077.exe' -and $ruw -match '"since":"2026-10-31T18:00:00')
Moet 'andere routes: 503' ([int]$post.Result.StatusCode -eq 503)
StopAntwoord
Moet 'na het stoppen is de poort vrij' ($null -eq $script:Luisteraar)

if ($fouten) { Write-Host "$fouten fout(en)"; exit 1 }
Write-Host 'alles goed'
