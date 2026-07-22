param(
  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$WorkerScriptPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('chat', 'recruit', 'recommend')]
  [string]$Domain,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$RunId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$LaunchId,

  [Parameter(Mandatory = $true)]
  [string]$StdoutPath,

  [Parameter(Mandatory = $true)]
  [string]$StderrPath,

  [Parameter(Mandatory = $true)]
  [string]$ExitStatusPath,

  [Parameter(Mandatory = $false)]
  [string]$RecommendRuntimeHomePath = '',

  [Parameter(Mandatory = $false)]
  [string]$ChatRuntimeHomePath = '',

  [Parameter(Mandatory = $false)]
  [string]$ScreenConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$startedAt = [DateTime]::UtcNow.ToString('o')
$workerPid = $null
$stdoutStream = $null
$stderrStream = $null

function Assert-ControlledPath([string]$Value, [string]$Label) {
  if (-not $Value -or -not [System.IO.Path]::IsPathRooted($Value)) {
    throw "$Label must be an absolute path."
  }
  if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '[\r\n"]') {
    throw "$Label contains unsupported characters."
  }
}

function Write-WorkerExitStatus($Payload) {
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($ExitStatusPath)) | Out-Null
  $tempPath = "$ExitStatusPath.tmp.$PID"
  $json = $Payload | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText($tempPath, $json, $utf8)
  if (Test-Path -LiteralPath $ExitStatusPath) {
    [System.IO.File]::Replace($tempPath, $ExitStatusPath, $null, $true)
  } else {
    [System.IO.File]::Move($tempPath, $ExitStatusPath)
  }
}

try {
  Assert-ControlledPath $NodePath 'NodePath'
  Assert-ControlledPath $WorkerScriptPath 'WorkerScriptPath'
  Assert-ControlledPath $StdoutPath 'StdoutPath'
  Assert-ControlledPath $StderrPath 'StderrPath'
  Assert-ControlledPath $ExitStatusPath 'ExitStatusPath'
  if ($RecommendRuntimeHomePath) {
    Assert-ControlledPath $RecommendRuntimeHomePath 'RecommendRuntimeHomePath'
  }
  if ($ChatRuntimeHomePath) {
    Assert-ControlledPath $ChatRuntimeHomePath 'ChatRuntimeHomePath'
  }
  if ($ScreenConfigPath) {
    Assert-ControlledPath $ScreenConfigPath 'ScreenConfigPath'
  }
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'NodePath does not exist.'
  }
  if (-not (Test-Path -LiteralPath $WorkerScriptPath -PathType Leaf)) {
    throw 'WorkerScriptPath does not exist.'
  }
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($StdoutPath)) | Out-Null
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($StderrPath)) | Out-Null
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($ExitStatusPath)) | Out-Null

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = ('"{0}" --domain {1} --run-id {2} --launch-id {3}' -f $WorkerScriptPath, $Domain, $RunId, $LaunchId)
  $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($WorkerScriptPath)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  if ($RecommendRuntimeHomePath) {
    $startInfo.EnvironmentVariables['BOSS_RECOMMEND_HOME'] = $RecommendRuntimeHomePath
  }
  if ($ChatRuntimeHomePath) {
    $startInfo.EnvironmentVariables['BOSS_CHAT_HOME'] = $ChatRuntimeHomePath
  }
  if ($ScreenConfigPath) {
    $startInfo.EnvironmentVariables['BOSS_RECOMMEND_SCREEN_CONFIG'] = $ScreenConfigPath
  }

  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo = $startInfo
  if (-not $worker.Start()) {
    throw 'Node detached worker did not start.'
  }
  $workerPid = [int]$worker.Id
  $stdoutStream = [System.IO.FileStream]::new(
    $StdoutPath,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite,
    1,
    [System.IO.FileOptions]::WriteThrough
  )
  $stderrStream = [System.IO.FileStream]::new(
    $StderrPath,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::ReadWrite,
    1,
    [System.IO.FileOptions]::WriteThrough
  )
  $stdoutTask = $worker.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
  $stderrTask = $worker.StandardError.BaseStream.CopyToAsync($stderrStream)
  $worker.WaitForExit()
  $stdoutTask.GetAwaiter().GetResult()
  $stderrTask.GetAwaiter().GetResult()
  $stdoutStream.Flush()
  $stderrStream.Flush()
  $stdoutStream.Dispose()
  $stderrStream.Dispose()
  $stdoutStream = $null
  $stderrStream = $null
  $workerExitCode = [int]$worker.ExitCode
  $exitedAt = [DateTime]::UtcNow.ToString('o')
  Write-WorkerExitStatus ([ordered]@{
    schema_version = 1
    domain = $Domain
    run_id = $RunId
    launch_id = $LaunchId
    wrapper_pid = [int]$PID
    worker_pid = $workerPid
    started_at = $startedAt
    exited_at = $exitedAt
    exit_code = $workerExitCode
    nonzero = ($workerExitCode -ne 0)
    termination_kind = 'observed_child_exit'
    wrapper_error = $null
  })

  try {
    $recordInfo = New-Object System.Diagnostics.ProcessStartInfo
    $recordInfo.FileName = $NodePath
    $recordInfo.Arguments = ('"{0}" --domain {1} --run-id {2} --launch-id {3} --record-exit --worker-exit-code {4} --worker-pid {5} --supervisor-pid {6}' -f $WorkerScriptPath, $Domain, $RunId, $LaunchId, $workerExitCode, $workerPid, $PID)
    $recordInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($WorkerScriptPath)
    $recordInfo.UseShellExecute = $false
    $recordInfo.CreateNoWindow = $true
    $recordInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $recordInfo.RedirectStandardOutput = $true
    $recordInfo.RedirectStandardError = $true
    if ($RecommendRuntimeHomePath) {
      $recordInfo.EnvironmentVariables['BOSS_RECOMMEND_HOME'] = $RecommendRuntimeHomePath
    }
    if ($ChatRuntimeHomePath) {
      $recordInfo.EnvironmentVariables['BOSS_CHAT_HOME'] = $ChatRuntimeHomePath
    }
    if ($ScreenConfigPath) {
      $recordInfo.EnvironmentVariables['BOSS_RECOMMEND_SCREEN_CONFIG'] = $ScreenConfigPath
    }
    $recorder = New-Object System.Diagnostics.Process
    $recorder.StartInfo = $recordInfo
    if ($recorder.Start()) {
      $recordStdoutTask = $recorder.StandardOutput.ReadToEndAsync()
      $recordStderrTask = $recorder.StandardError.ReadToEndAsync()
      $recorder.WaitForExit()
      $recordStdout = $recordStdoutTask.GetAwaiter().GetResult()
      $recordStderr = $recordStderrTask.GetAwaiter().GetResult()
      if ($recordStdout) {
        [System.IO.File]::AppendAllText($StdoutPath, $recordStdout, $utf8)
      }
      if ($recordStderr) {
        [System.IO.File]::AppendAllText($StderrPath, $recordStderr, $utf8)
      }
    }
  } catch {
    [System.IO.File]::AppendAllText(
      $StderrPath,
      "[windows-detached-worker] exit recorder failed: $($_.Exception.Message)$([Environment]::NewLine)",
      $utf8
    )
  }
  exit $workerExitCode
} catch {
  $wrapperError = $_.Exception.Message
  try {
    Write-WorkerExitStatus ([ordered]@{
      schema_version = 1
      domain = $Domain
      run_id = $RunId
      launch_id = $LaunchId
      wrapper_pid = [int]$PID
      worker_pid = $workerPid
      started_at = $startedAt
      exited_at = [DateTime]::UtcNow.ToString('o')
      exit_code = 1
      nonzero = $true
      termination_kind = 'wrapper_error'
      wrapper_error = $wrapperError
    })
  } catch {
    # The controlled sidecar may be unavailable for the same reason as the wrapper failure.
  }
  try {
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($StderrPath)) | Out-Null
    [System.IO.File]::AppendAllText(
      $StderrPath,
      "[windows-detached-worker] $wrapperError$([Environment]::NewLine)",
      $utf8
    )
  } catch {
    # No additional recovery is available if even the controlled log path is unavailable.
  }
  exit 1
} finally {
  if ($stdoutStream) {
    try { $stdoutStream.Dispose() } catch {}
  }
  if ($stderrStream) {
    try { $stderrStream.Dispose() } catch {}
  }
}
