/**
 * Agent Detector Module
 * 
 * Auto-detects CLI coding agents installed on the system by probing
 * the system PATH using `where` (Windows) or `which` (Unix).
 */

'use strict';

const { execFile } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------------------
// Known CLI agents the orchestrator can work with
// ---------------------------------------------------------------------------
const KNOWN_AGENTS = [
  {
    name: 'Antigravity (agy)',
    command: 'agy',
    icon: '✦',
    color: '#4285F4',
    description: "Antigravity AI coding assistant",
  },
  {
    name: 'GitHub Copilot',
    command: 'copilot',
    icon: '⬡',
    color: '#6E40C9',
    description: "GitHub's AI pair programmer",
  },
  {
    name: 'OpenCode',
    command: 'opencode',
    icon: '◈',
    color: '#00D4AA',
    description: 'Open-source AI coding tool',
  },
  {
    name: 'Codex CLI',
    command: 'codex',
    icon: '◆',
    color: '#10A37F',
    description: "OpenAI's coding assistant",
  },
  {
    name: 'Claude Code',
    command: 'claude',
    icon: '◉',
    color: '#D97706',
    description: "Anthropic's AI assistant",
  },
  {
    name: 'Aider',
    command: 'aider',
    icon: '▲',
    color: '#EF4444',
    description: 'AI pair programming tool',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a command is available on the system PATH.
 *
 * @param {string} cmd - The command name to look up.
 * @returns {Promise<{installed: boolean, path: string|null}>}
 */
function checkCommand(cmd) {
  const isWindows = os.platform() === 'win32';
  const lookup = isWindows ? 'where' : 'which';

  return new Promise((resolve) => {
    execFile(lookup, [cmd], (err, stdout) => {
      if (err) {
        // Command not found – this is expected, not an error worth logging
        return resolve({ installed: false, path: null });
      }

      // `where` may return multiple lines. Prefer executable shims over
      // PowerShell shims so npm CLIs still work when script execution is disabled.
      const candidates = stdout.trim().split(/\r?\n/).filter(Boolean);
      const resolvedPath = isWindows
        ? candidates.find((item) => /\.(cmd|exe|bat)$/i.test(item)) || candidates[0] || null
        : candidates[0] || null;
      resolve({ installed: !!resolvedPath, path: resolvedPath });
    });
  });
}

/**
 * Detect all known and custom agents by checking each command in parallel.
 *
 * @param {Array<Object>} [customAgents] - User-added custom agents.
 * @returns {Promise<Array<Object>>} Array of agent objects enriched with
 *   `installed` (boolean) and `path` (string|null) fields.
 */
async function detectAgents(customAgents = []) {
  let customList = customAgents;
  if (customList && !Array.isArray(customList)) {
    customList = [customList];
  }
  if (!customList) {
    customList = [];
  }
  const list = [...KNOWN_AGENTS, ...customList];
  const seen = new Set();
  const uniqueList = [];
  for (const item of list) {
    if (item && item.command && !seen.has(item.command)) {
      seen.add(item.command);
      uniqueList.push(item);
    }
  }

  const results = await Promise.all(
    uniqueList.map(async (agent) => {
      const { installed, path } = await checkCommand(agent.command);
      const enriched = {
        name: agent.name || agent.command,
        command: agent.command,
        icon: agent.icon || '⚙️',
        color: agent.color || '#94A3B8',
        description: agent.description || 'Custom CLI agent',
        ...agent
      };
      return { ...enriched, installed, path };
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { detectAgents, KNOWN_AGENTS };
