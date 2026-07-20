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
  [string]$StdoutPath,

  [Parameter(Mandatory = $true)]
  [string]$StderrPath,

  [Parameter(Mandatory = $false)]
  [string]$ChatRuntimeHomePath = '',

  [Parameter(Mandatory = $false)]
  [string]$ScreenConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Assert-ControlledPath([string]$Value, [string]$Label) {
  if (-not $Value -or -not [System.IO.Path]::IsPathRooted($Value)) {
    throw "$Label must be an absolute path."
  }
  if ($Value.IndexOf([char]0) -ge 0 -or $Value -match '[\r\n"]') {
    throw "$Label contains unsupported characters."
  }
}

try {
  Assert-ControlledPath $NodePath 'NodePath'
  Assert-ControlledPath $WorkerScriptPath 'WorkerScriptPath'
  Assert-ControlledPath $StdoutPath 'StdoutPath'
  Assert-ControlledPath $StderrPath 'StderrPath'
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

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = ('"{0}" --domain {1} --run-id {2}' -f $WorkerScriptPath, $Domain, $RunId)
  $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($WorkerScriptPath)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
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
  $stdoutTask = $worker.StandardOutput.ReadToEndAsync()
  $stderrTask = $worker.StandardError.ReadToEndAsync()
  $worker.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout) {
    [System.IO.File]::AppendAllText($StdoutPath, $stdout, $utf8)
  }
  if ($stderr) {
    [System.IO.File]::AppendAllText($StderrPath, $stderr, $utf8)
  }
  exit [int]$worker.ExitCode
} catch {
  try {
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($StderrPath)) | Out-Null
    [System.IO.File]::AppendAllText(
      $StderrPath,
      "[windows-detached-worker] $($_.Exception.Message)$([Environment]::NewLine)",
      $utf8
    )
  } catch {
    # No additional recovery is available if even the controlled log path is unavailable.
  }
  exit 1
}
