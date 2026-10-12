[CmdletBinding()]
param([string]$Profile='desktop',[string]$DshHome=(Join-Path $env:USERPROFILE '.dsh'),[string]$SdkAnchor='', [switch]$NoStartup,[switch]$Uninstall)
$ErrorActionPreference='Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$argsList = @((Join-Path $PSScriptRoot 'tools\install-state.mjs'),'--home',$DshHome,'--profile',$Profile)
if ($SdkAnchor) { $argsList += @('--sdk',$SdkAnchor) }
if ($NoStartup) { $argsList += '--no-startup' }
if ($Uninstall) { $argsList += '--uninstall' }
& $node @argsList
exit $LASTEXITCODE
