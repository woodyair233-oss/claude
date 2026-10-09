# Exercises the powrprof.dll layer of the built exe on a real Windows machine (the CI runner):
# reads the active plan, round-trips writes, and lists the power-button actions Windows offers.
# Every value that is changed is restored afterwards.
param(
    [Parameter(Mandatory = $true)][string]$ExePath
)
$ErrorActionPreference = 'Stop'

$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path $ExePath).Path)
$api = $assembly.GetType('PowerHelper.PowerApi', $true)
$flags = [Reflection.BindingFlags]'Static, Public, NonPublic'

function Invoke-Api([string]$name, [object[]]$arguments) { $api.GetMethod($name, $flags).Invoke($null, $arguments) }
function Get-ApiField([string]$name) { $api.GetField($name, $flags).GetValue($null) }
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

$scheme = Invoke-Api 'GetActiveScheme' @()
$name = Invoke-Api 'GetSchemeName' @($scheme)
"Active plan: $scheme ($name)"
Assert ($scheme -ne [Guid]::Empty) 'active scheme GUID'
Assert (-not [string]::IsNullOrEmpty($name)) 'active scheme name'

$settings = @(
    @{ Label = 'VIDEOIDLE';     Sub = 'SubVideo';   Setting = 'VideoIdle' },
    @{ Label = 'STANDBYIDLE';   Sub = 'SubSleep';   Setting = 'StandbyIdle' },
    @{ Label = 'HIBERNATEIDLE'; Sub = 'SubSleep';   Setting = 'HibernateIdle' },
    @{ Label = 'PBUTTONACTION'; Sub = 'SubButtons'; Setting = 'PowerButtonAction' }
)
foreach ($s in $settings) {
    $sub = Get-ApiField $s.Sub
    $setting = Get-ApiField $s.Setting
    $ac = Invoke-Api 'ReadValue' @($scheme, $sub, $setting, $true)
    $dc = Invoke-Api 'ReadValue' @($scheme, $sub, $setting, $false)
    "{0,-14} AC={1} DC={2}  policy={3}" -f $s.Label, $ac, $dc, (Invoke-Api 'IsSetByPolicy' @($setting))
}

# Cross-check one value against powercfg (the CI runner is English Windows).
$videoAc = Invoke-Api 'ReadValue' @($scheme, (Get-ApiField 'SubVideo'), (Get-ApiField 'VideoIdle'), $true)
$powercfgLine = powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-fA-F]+)'
Assert ($null -ne $powercfgLine) 'powercfg printed the AC index'
$powercfgHex = $powercfgLine.Matches[0].Groups[1].Value
"powercfg VIDEOIDLE AC index: $powercfgHex"
Assert ([Convert]::ToUInt32($powercfgHex, 16) -eq $videoAc) 'ReadValue matches powercfg'

function Test-RoundTrip([string]$sub, [string]$setting, [uint32]$newValue) {
    $subGuid = Get-ApiField $sub
    $settingGuid = Get-ApiField $setting
    foreach ($pluggedIn in @($true, $false)) {
        $old = Invoke-Api 'ReadValue' @($scheme, $subGuid, $settingGuid, $pluggedIn)
        try {
            Invoke-Api 'WriteValue' @($scheme, $subGuid, $settingGuid, $pluggedIn, $newValue)
            Invoke-Api 'Activate' @($scheme)
            $read = Invoke-Api 'ReadValue' @($scheme, $subGuid, $settingGuid, $pluggedIn)
            Assert ($read -eq $newValue) "$setting pluggedIn=$pluggedIn round trip ($read != $newValue)"
        } finally {
            Invoke-Api 'WriteValue' @($scheme, $subGuid, $settingGuid, $pluggedIn, $old)
            Invoke-Api 'Activate' @($scheme)
        }
    }
    "$setting round trip OK"
}
Test-RoundTrip 'SubVideo' 'VideoIdle' ([uint32]420)

$actions = @()
foreach ($index in 0..9) {
    $actionName = Invoke-Api 'GetPossibleValueName' @((Get-ApiField 'SubButtons'), (Get-ApiField 'PowerButtonAction'), [uint32]$index)
    if ($actionName) { $actions += "$index=$actionName" }
}
"Power button actions offered: $($actions -join ', ')"
Assert ($actions.Count -gt 0) 'power button actions listed'
if ($actions -match '^4=') {
    Test-RoundTrip 'SubButtons' 'PowerButtonAction' ([uint32]4)
} else {
    Write-Warning 'This Windows build does not offer "Turn off the display" (index 4).'
}

$capabilities = Invoke-Api 'GetCapabilities' @()
$capType = $capabilities.GetType()
"Hibernate enabled: $($capType.GetField('HibernateEnabled').GetValue($capabilities)); battery: $($capType.GetField('HasBattery').GetValue($capabilities))"

'Smoke test passed.'
