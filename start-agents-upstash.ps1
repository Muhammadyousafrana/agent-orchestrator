# Start upstash-based agent wrappers in background processes
$root = 'C:\Users\yousa\agent-orchestrator'
$agents = @('codex','opencode','gemini','copilot')
foreach ($a in $agents) {
  $args = "$root\\agent-wrapper-upstash.js --agent $a"
  Start-Process -FilePath node -ArgumentList $args -WorkingDirectory $root
  Write-Host "Started upstash agent wrapper: $a"
}
Write-Host "All upstash wrappers started."