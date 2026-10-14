# Start agent wrappers in background processes (PowerShell)
$root = 'C:\Users\yousa\agent-orchestrator'
$agents = @('codex','opencode','gemini','copilot')
foreach ($a in $agents) {
  $args = "$root\\agent-wrapper.js --agent $a"
  Start-Process -FilePath node -ArgumentList $args -WorkingDirectory $root
  Write-Host "Started agent wrapper: $a"
}
Write-Host "All wrappers started. Check logs in their console windows." 
