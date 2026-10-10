# Exercises the powrprof.dll layer of the built exe on a real Windows machine (the CI runner):
# reads the active plan, round-trips writes, lists the power-button actions Windows offers and
# creates the screen-off desktop shortcut. Every change is undone afterwards.
param(
    [Parameter(Mandatory = $true)][string]$ExePath
)
$ErrorActionPreference = 'Stop'

$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path $ExePath).Path)
$api = $assembly.GetType('PowerHelper.PowerApi', $true)
$flags = [Reflection.BindingFlags]'Static, Public, NonPublic'

# Calls a static method of the exe; on failure, reports the innermost exception instead of
# "Exception has been thrown by the target of an invocation".
function Invoke-Static([Type]$type, [string]$name, [object[]]$arguments) {
    try {
        $type.GetMethod($name, $flags).Invoke($null, $arguments)
    } catch {
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        throw "$name failed: $($inner.GetType().FullName): $($inner.Message)`n$($inner.StackTrace)"
    }
}
function Invoke-Api([string]$name, [object[]]$arguments) { Invoke-Static $api $name $arguments }
function Get-ApiField([string]$name) { $api.GetField($name, $flags).GetValue($null) }
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw "FAILED: $message" } }

$scheme = Invoke-Api 'GetActiveScheme' @()
$name = Invoke-Api 'GetSchemeName' @($scheme)
"Active plan: $scheme ($name)"
Assert ($scheme -ne [Guid]::Empty) 'active scheme GUID'
Assert (-not [string]::IsNullOrEmpty($name)) 'active scheme name'

$settings = @(
    @{ Label = 'VIDEOIDLE';     Sub = 'SubVideo';   Setting = 'VideoIdle';         Name = 'display' },
    @{ Label = 'STANDBYIDLE';   Sub = 'SubSleep';   Setting = 'StandbyIdle';       Name = 'Sleep after' },
    @{ Label = 'HIBERNATEIDLE'; Sub = 'SubSleep';   Setting = 'HibernateIdle';     Name = 'Hibernate after' },
    @{ Label = 'PBUTTONACTION'; Sub = 'SubButtons'; Setting = 'PowerButtonAction'; Name = 'Power button' },
    @{ Label = 'LIDACTION';     Sub = 'SubButtons'; Setting = 'LidAction';         Name = 'Lid' }
)

# Windows' own (English) name of a setting, to prove each GUID constant points at the intended setting.
Add-Type -Namespace SmokeTest -Name Power -MemberDefinition @'
[DllImport("powrprof.dll")]
static extern uint PowerReadFriendlyName(IntPtr root, ref Guid scheme, ref Guid sub, ref Guid setting, byte[] buffer, ref uint size);
public static string SettingName(Guid scheme, Guid sub, Guid setting) {
    uint size = 0;
    PowerReadFriendlyName(IntPtr.Zero, ref scheme, ref sub, ref setting, null, ref size);
    var buffer = new byte[size];
    if (PowerReadFriendlyName(IntPtr.Zero, ref scheme, ref sub, ref setting, buffer, ref size) != 0) return null;
    return System.Text.Encoding.Unicode.GetString(buffer).TrimEnd('\0');
}
'@
foreach ($s in $settings) {
    $sub = Get-ApiField $s.Sub
    $setting = Get-ApiField $s.Setting
    $ac = Invoke-Api 'ReadValue' @($scheme, $sub, $setting, $true)
    $dc = Invoke-Api 'ReadValue' @($scheme, $sub, $setting, $false)
    $settingName = [SmokeTest.Power]::SettingName($scheme, $sub, $setting)
    "{0,-14} AC={1} DC={2}  policy={3}  name='{4}'" -f $s.Label, $ac, $dc, (Invoke-Api 'IsSetByPolicy' @($setting)), $settingName
    Assert ($settingName -match $s.Name) "$($s.Label) GUID is the '$($s.Name)' setting"
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
foreach ($field in 'HibernateEnabled', 'HasBattery', 'HasLid', 'ModernStandby') {
    "${field}: $($capType.GetField($field).GetValue($capabilities))"
}

# Desktop shortcut with a hotkey for "turn off only the display".
$screenOff = $assembly.GetType('PowerHelper.ScreenOff', $true)
$shortcutPath = Invoke-Static $screenOff 'CreateDesktopShortcut' @((Resolve-Path $ExePath).Path)
try {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    "Shortcut: $shortcutPath -> $($link.TargetPath) $($link.Arguments) [$($link.Hotkey)]"
    Assert (Test-Path $link.TargetPath) 'shortcut target was copied'
    Assert ($link.TargetPath -like '*\PowerHelper\PowerHelper.exe') 'shortcut target folder'
    Assert ($link.Arguments -eq '/screenoff') 'shortcut arguments'
    $keys = ($link.Hotkey -split '\+' | Sort-Object) -join '+'
    Assert ($keys -eq 'Alt+Ctrl+S') "shortcut hotkey ($($link.Hotkey))"
} finally {
    Remove-Item $shortcutPath -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:LOCALAPPDATA 'PowerHelper') -Recurse -ErrorAction SilentlyContinue
}

'Smoke test passed.'
