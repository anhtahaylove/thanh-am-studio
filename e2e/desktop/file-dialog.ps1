param([Parameter(Mandatory)][string]$Path, [int]$TimeoutSeconds = 30)
# Fills the native Open/Save common dialog by UI Automation (language independent).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$P = [System.Windows.Automation.PropertyCondition]
$dialogCond = New-Object $P ($A::ClassNameProperty, '#32770')
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    # Dialogs are owned by the app window, so search two levels below the desktop.
    $dialog = $A::RootElement.FindFirst($T::Children, $dialogCond)
    if (-not $dialog) {
        foreach ($w in $A::RootElement.FindAll($T::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            $dialog = $w.FindFirst($T::Children, $dialogCond); if ($dialog) { break }
        }
    }
    if ($dialog) {
        $edit = $null
        foreach ($id in '1001', '1148') {
            $c = New-Object System.Windows.Automation.AndCondition @((New-Object $P ($A::AutomationIdProperty, $id)), (New-Object $P ($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
            $edit = $dialog.FindFirst($T::Descendants, $c); if ($edit) { break }
        }
        if ($edit) {
            $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
            Start-Sleep -Milliseconds 300
            $ok = $dialog.FindFirst($T::Children, (New-Object $P ($A::AutomationIdProperty, '1')))
            $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Write-Output "filled $Path"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 300
}
throw "File dialog not found within $TimeoutSeconds s"
