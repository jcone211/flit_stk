<#
.SYNOPSIS
    flit_bridge 安装脚本 - 注册为 Windows 计划任务实现后台驻留
.DESCRIPTION
    在 Windows Task Scheduler 中注册一个用户登录时启动的任务，
    无需 PowerShell 窗口常开。
    若不想用计划任务，也可直接运行 start-server.ps1。
#>

#Requires -Version 7.0

param(
    [string]$BridgeDir = $PSScriptRoot,
    [switch]$Uninstall,
    [switch]$Status
)

$taskName = "flit_bridge_watcher"
$taskPath = "\flit_bridge\"

if ($Status) {
    $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "flit_bridge 计划任务状态: $($task.State)"
        Write-Host "  最近运行: $($task.LastRunTime)"
        Write-Host "  结果: $($task.LastTaskResult)"
    } else {
        Write-Host "flit_bridge 未注册为计划任务"
    }
    return
}

if ($Uninstall) {
    try {
        Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "已卸载计划任务: $taskName" -ForegroundColor Green
    } catch {
        Write-Host "计划任务不存在或卸载失败: $_" -ForegroundColor Yellow
    }
    return
}

# 验证依赖
$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$watchScript = Join-Path $BridgeDir "start-server.ps1"
$serverPath = Join-Path $BridgeDir "server.js"

if (-not (Test-Path -LiteralPath $watchScript)) { Write-Error "缺少 $watchScript"; return }
if (-not (Test-Path -LiteralPath $serverPath)) { Write-Error "缺少 $serverPath"; return }

# 注册计划任务（用户登录时启动，隐藏窗口）
$action = New-ScheduledTaskAction `
    -Execute $pwshPath `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

$username = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $username -LogonType S4U

try {
    Register-ScheduledTask `
        -TaskPath $taskPath `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force `
        -ErrorAction Stop

    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  flit_bridge 安装成功" -ForegroundColor Green
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  计划任务: $taskPath$taskName" -ForegroundColor White
    Write-Host "  脚本路径: $watchScript" -ForegroundColor White
    Write-Host "  服务地址: http://127.0.0.1:17321" -ForegroundColor White
    Write-Host "  健康检查: curl http://127.0.0.1:17321/health" -ForegroundColor White
    Write-Host "" -ForegroundColor White
    Write-Host "  下次登录时自动启动，或立即启动：" -ForegroundColor White
    Write-Host "  Start-ScheduledTask -TaskPath '$taskPath' -TaskName '$taskName'" -ForegroundColor Yellow
    Write-Host "" -ForegroundColor White
    Write-Host "  卸载：" -ForegroundColor White
    Write-Host "  $PSCommandPath -Uninstall" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Green
} catch {
    Write-Error "安装失败: $_"
}
