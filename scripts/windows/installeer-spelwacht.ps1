<#
Installeert Spelwacht (spelwacht.ps1, in dezelfde map) op de GPU-machine:
  - een geplande taak "Spelwacht" die bij het aanmelden start, verborgen en met
    de hoogste rechten (om de worker te mogen stoppen als die als beheerder draait);
  - een regel in de Windows Firewall, zodat de Regiochecker (via Tailscale) het
    antwoord van Spelwacht op poort 8765 kan lezen zolang de worker stilstaat.
Daarna start de taak meteen.

Uitvoeren in PowerShell als administrator:
  powershell -ExecutionPolicy Bypass -File installeer-spelwacht.ps1
Weghalen:
  powershell -ExecutionPolicy Bypass -File installeer-spelwacht.ps1 -Verwijder
#>
[CmdletBinding()]
param([switch]$Verwijder)

$Taak = 'Spelwacht'
$Regel = 'Spelwacht (Regiochecker)'
$Script = Join-Path $PSScriptRoot 'spelwacht.ps1'
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$beheerder = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $beheerder) { throw 'Start PowerShell als administrator (rechtsklik, "Als administrator uitvoeren").' }

if ($Verwijder) {
  Stop-ScheduledTask -TaskName $Taak -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Taak -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $Regel -ErrorAction SilentlyContinue
  Write-Host 'Spelwacht is weggehaald. Start de worker zo nodig zelf (geplande taak "Plaud Whisper Worker").'
  return
}

if (-not (Test-Path $Script)) { throw "spelwacht.ps1 staat niet naast dit script ($Script)." }

$actie = New-ScheduledTaskAction -Execute $PowerShell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$wie = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
# Geen tijdslimiet, en na een fout opnieuw proberen.
$opties = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Taak -Action $actie -Trigger $trigger -Principal $wie -Settings $opties -Description 'Pauzeert de Whisper-worker en Ollama zolang er een spel draait (Regiochecker).' -Force | Out-Null

Remove-NetFirewallRule -DisplayName $Regel -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $Regel -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Program $PowerShell -Profile Any | Out-Null

Start-ScheduledTask -TaskName $Taak
Write-Host "Spelwacht is geinstalleerd en gestart. Logboek: $env:LOCALAPPDATA\Spelwacht\spelwacht.log"
Write-Host "Eerst proberen zonder iets te doen kan ook: powershell -ExecutionPolicy Bypass -File `"$Script`" -Proef"
