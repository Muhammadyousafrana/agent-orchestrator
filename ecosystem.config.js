module.exports = {
  apps: [
    {
      name: 'agent-server',
      script: 'server_upstash.js',
      cwd: 'C:\\Users\\yousa\\agent-orchestrator',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'codex-agent',
      script: 'agent-wrapper-upstash.js',
      args: '--agent codex',
      cwd: 'C:\\Users\\yousa\\agent-orchestrator',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'opencode-agent',
      script: 'agent-wrapper-upstash.js',
      args: '--agent opencode',
      cwd: 'C:\\Users\\yousa\\agent-orchestrator',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'gemini-agent',
      script: 'agent-wrapper-upstash.js',
      args: '--agent gemini',
      cwd: 'C:\\Users\\yousa\\agent-orchestrator',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'copilot-agent',
      script: 'agent-wrapper-upstash.js',
      args: '--agent copilot',
      cwd: 'C:\\Users\\yousa\\agent-orchestrator',
      env: { NODE_ENV: 'production' }
    }
  ]
};
