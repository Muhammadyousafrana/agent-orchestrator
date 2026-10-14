/**
 * Orchestrator Module
 *
 * Core workflow orchestration engine. A Workflow drives one or more CLI
 * agents through ordered phases (design → build → test → review → integrate),
 * emitting rich events that the server can relay over WebSocket.
 */

'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ProcessRunner } = require('./process-runner');

// ---------------------------------------------------------------------------
// Role & phase definitions
// ---------------------------------------------------------------------------

const ROLES = {
  orchestrator: {
    label: 'Parent Orchestrator',
    description: 'Plans, delegates, reviews child handoffs, and coordinates the workflow',
    phase: 'orchestrate',
    responsibilities: [
      'break the task into child-agent assignments',
      'review child handoffs after each phase',
      'decide the next handoff and final integration guidance',
    ],
  },
  architect: {
    label: 'System Architect',
    description: 'Designs system architecture and technical approach',
    phase: 'design',
    responsibilities: [
      'inspect the project structure',
      'define the implementation plan',
      'identify risks, dependencies, and handoff notes',
    ],
  },
  builder: {
    label: 'Feature Builder',
    description: 'Implements features and writes production code',
    phase: 'build',
    responsibilities: [
      'make the requested code changes',
      'keep edits scoped to the plan',
      'record changed files and important decisions',
    ],
  },
  tester: {
    label: 'Tester',
    description: 'Writes and runs tests to verify correctness',
    phase: 'test',
    responsibilities: [
      'run focused validation for the changed behavior',
      'add or update tests when the project has an obvious test location',
      'report failures with exact commands and error text',
    ],
  },
  reviewer: {
    label: 'Code Reviewer',
    description: 'Reviews code quality, security, and best practices',
    phase: 'review',
    responsibilities: [
      'review the diff for bugs, safety issues, and regressions',
      'check whether the implementation matches the original task',
      'provide actionable findings or approval',
    ],
  },
  integrator: {
    label: 'Integrator',
    description: 'Integrates changes and ensures everything works together',
    phase: 'integrate',
    responsibilities: [
      'combine prior agent work into a coherent final state',
      'resolve handoff conflicts when possible',
      'summarize the final outcome and next steps',
    ],
  },
};

const PHASE_ORDER = ['orchestrate', 'design', 'build', 'test', 'review', 'integrate'];

// ---------------------------------------------------------------------------
// CLI invocation patterns — each agent CLI has different arg syntax
// ---------------------------------------------------------------------------

const CLI_PATTERNS = {
  agy:      (prompt) => ['--dangerously-skip-permissions', '-p', prompt],
  gemini:   (prompt) => ['-p', prompt, '-y', '--skip-trust'],
  copilot:  (prompt) => ['-p', prompt],
  opencode: (prompt) => ['run', '--dangerously-skip-permissions', prompt],
  codex:    (prompt) => ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt],
  claude:   (prompt) => ['--dangerously-skip-permissions', '-p', prompt],
  aider:    (prompt) => ['--message', prompt, '--yes'],
};

const CLOSE_STDIN_FOR_AUTO_APPROVED_CLIS = new Set([
  'agy',
  'aider',
  'claude',
  'codex',
  'gemini',
  'opencode',
]);

const DEFAULT_PERMISSION_CHOICES = [
  { label: 'Allow once', value: 'y' },
  { label: 'Allow all', value: 'a' },
  { label: 'Deny', value: 'n' },
];

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '');
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function makeInline(value, maxLength = 2000) {
  return truncate(String(value || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim(), maxLength);
}

function looksLikePermissionPrompt(value) {
  const text = stripAnsi(value).trim();
  if (!text) return false;

  return [
    /\b(permission|approval|approve|allow|authorize|authorization|confirmation|confirm)\b/i,
    /\b(yes\/no|y\/n|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(Y\/n\))\b/i,
    /\b(do you want to|would you like to|proceed|continue)\b[^.?!]*(\?|\[)/i,
    /\b(press|enter|select)\b.{0,60}\b(y|yes|a|allow|n|no)\b/i,
  ].some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

class Workflow extends EventEmitter {
  /**
   * @param {Object}   config
   * @param {string}   config.id          - Unique workflow identifier.
   * @param {Array}    config.agents      - [{name, command, role}, …]
   * @param {string}   config.projectPath - Absolute path to the project.
   * @param {string}   config.idea        - Natural-language description of the task.
   * @param {string}   config.mode        - 'sequential' | 'parallel'
   */
  constructor({ id, agents, projectPath, idea, mode = 'sequential' }) {
    super();

    this.id = id;
    this.agents = agents;
    this.projectPath = projectPath;
    this.idea = idea;
    this.mode = mode;

    // Build a phases map: { phaseName: [agent, …] }
    this.phases = {};
    for (const agent of agents) {
      const roleInfo = ROLES[agent.role];
      const phase = roleInfo ? roleInfo.phase : agent.role;
      if (!this.phases[phase]) this.phases[phase] = [];
      this.phases[phase].push(agent);
    }

    this.status = 'pending'; // pending | running | completed | failed | stopped
    this.agentOutputs = {}; // agent.name → accumulated output
    this.runners = []; // active ProcessRunner instances
    this.runnersByAgent = new Map(); // agent name/command -> ProcessRunner
    this.pendingPermissions = new Map(); // agent.name -> permission request
    this.permissionRequestSeq = 0;
    this.agentMessages = [];
    this.internalSubagentEvents = [];
    this.messageBuffers = new Map();
    this.launchClaimWarnings = new Set();
    this.messageSeq = 0;
    this.subagentSeq = 0;
    this.startedAt = null;
    this.completedAt = null;
  }

  getParentAgents() {
    return this.agents.filter((agent) => agent.role === 'orchestrator');
  }

  getChildAgents() {
    return this.agents.filter((agent) => agent.role !== 'orchestrator');
  }

  describeAgent(agent) {
    const role = ROLES[agent.role] || { label: agent.role, phase: agent.role, description: '' };
    return `${agent.name} (${agent.command}) as ${role.label}, role=${agent.role}, phase=${role.phase || agent.role}`;
  }

  describeChildRoster() {
    const childAgents = this.getChildAgents();
    return childAgents.length > 0
      ? childAgents.map((agent) => this.describeAgent(agent)).join('; ')
      : 'no selected child CLI agents';
  }

  normaliseRecipient(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  parseMessageLine(line) {
    const bracketMatch = String(line).match(/^\s*(?:AGENT\s+)?MESSAGE\s+TO\s+\[([^\]]+)\]\s*:\s*(.+)$/i);
    if (bracketMatch) {
      return {
        to: bracketMatch[1].trim(),
        body: bracketMatch[2].trim(),
      };
    }

    const simpleMatch = String(line).match(/^\s*(?:AGENT\s+)?MESSAGE\s+TO\s+([^:]+)\s*:\s*(.+)$/i);
    if (!simpleMatch) return null;

    return {
      to: simpleMatch[1].trim(),
      body: simpleMatch[2].trim(),
    };
  }

  parseSubagentLine(line) {
    const typedMatch = String(line).match(/^\s*SUBAGENT\s+(START|OUTPUT|DONE|ERROR)\s+\[([^\]]+)\]\s*:\s*(.+)$/i);
    if (typedMatch) {
      return {
        status: typedMatch[1].toLowerCase(),
        name: typedMatch[2].trim(),
        body: typedMatch[3].trim(),
      };
    }

    const simpleMatch = String(line).match(/^\s*SUBAGENT\s+\[([^\]]+)\]\s*:\s*(.+)$/i);
    if (!simpleMatch) return null;

    return {
      status: 'output',
      name: simpleMatch[1].trim(),
      body: simpleMatch[2].trim(),
    };
  }

  captureAgentMessages(agent, phaseName, data) {
    const previous = this.messageBuffers.get(agent.name) || '';
    const combined = previous + String(data || '');
    const lines = combined.split(/\r?\n/);
    const remainder = lines.pop() || '';
    this.messageBuffers.set(agent.name, remainder);

    for (const line of lines) {
      this.recordMessageFromLine(agent, phaseName, line);
      this.recordSubagentFromLine(agent, phaseName, line);
    }
  }

  flushAgentMessageBuffer(agent, phaseName) {
    const remainder = this.messageBuffers.get(agent.name);
    if (remainder) {
      this.recordMessageFromLine(agent, phaseName, remainder);
      this.recordSubagentFromLine(agent, phaseName, remainder);
    }
    this.messageBuffers.delete(agent.name);
  }

  recordMessageFromLine(agent, phaseName, line) {
    const parsed = this.parseMessageLine(line);
    if (!parsed || !parsed.body) return;

    const roleInfo = ROLES[agent.role] || { label: agent.role, phase: agent.role };
    const message = {
      id: `msg-${++this.messageSeq}`,
      workflowId: this.id,
      from: agent.name,
      fromCommand: agent.command,
      fromRole: agent.role,
      fromRoleLabel: roleInfo.label,
      phase: phaseName,
      to: parsed.to,
      body: parsed.body,
      createdAt: new Date().toISOString(),
    };

    this.agentMessages.push(message);
    if (this.agentMessages.length > 200) {
      this.agentMessages = this.agentMessages.slice(-200);
    }
    this.emit('agent:message', message);
  }

  recordSubagentFromLine(agent, phaseName, line) {
    const parsed = this.parseSubagentLine(line);
    if (!parsed || !parsed.body || !parsed.name) return;

    const roleInfo = ROLES[agent.role] || { label: agent.role, phase: agent.role };
    const event = {
      id: `subagent-${++this.subagentSeq}`,
      workflowId: this.id,
      parentAgent: agent.name,
      parentCommand: agent.command,
      parentRole: agent.role,
      parentRoleLabel: roleInfo.label,
      phase: phaseName,
      subagent: parsed.name,
      status: parsed.status,
      body: parsed.body,
      createdAt: new Date().toISOString(),
    };

    this.internalSubagentEvents.push(event);
    if (this.internalSubagentEvents.length > 200) {
      this.internalSubagentEvents = this.internalSubagentEvents.slice(-200);
    }
    this.emit('agent:subagent_event', event);
  }

  detectMisleadingChildLaunchClaim(agent, phaseName, data) {
    if (agent.role !== 'orchestrator') return;

    const text = stripAnsi(data);
    if (!/\b(background|running in the background|started .*background)\b/i.test(text)) return;

    const childAgents = this.getChildAgents();
    const mentionedChild = childAgents.find((child) => {
      const escapedName = child.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedCommand = child.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b(${escapedName}|${escapedCommand})\\b`, 'i').test(text);
    });
    if (!mentionedChild) return;

    const key = `${agent.name}:${mentionedChild.name}:${phaseName}`;
    if (this.launchClaimWarnings.has(key)) return;
    this.launchClaimWarnings.add(key);

    const warning =
      `\n[orchestrator] ${agent.name} cannot background selected child CLI ${mentionedChild.name}. ` +
      `The orchestrator service will launch ${mentionedChild.name} after the parent checkpoint exits.\n`;
    this.agentOutputs[agent.name] += warning;
    this.emit('agent:output', {
      workflowId: this.id,
      agent: agent.name,
      command: agent.command,
      phase: phaseName,
      stream: 'stderr',
      data: warning,
    });
  }

  messageTargetsAgent(message, agent) {
    if (!agent) return true;

    const target = this.normaliseRecipient(message.to);
    const agentName = this.normaliseRecipient(agent.name);
    const command = this.normaliseRecipient(agent.command);
    const role = this.normaliseRecipient(agent.role);
    const roleLabel = this.normaliseRecipient((ROLES[agent.role] || {}).label);
    const isParent = agent.role === 'orchestrator';

    if (['all', 'broadcast', 'everyone', 'team'].includes(target)) return true;
    if (target === agentName || target === command || target === role || target === roleLabel) return true;
    if (target === `role:${role}` || target === `role ${role}`) return true;
    if (isParent && ['parent', 'parent orchestrator', 'orchestrator'].includes(target)) return true;
    if (!isParent && ['children', 'child agents', 'selected child cli agents'].includes(target)) return true;

    return false;
  }

  formatMessage(message) {
    return `- [${message.createdAt}] ${message.from} (${message.fromRole}) -> ${message.to}: ${message.body}`;
  }

  formatSubagentEvent(event) {
    return `- [${event.createdAt}] ${event.parentAgent} / ${event.subagent} (${event.status}): ${event.body}`;
  }

  getSortedPhases({ includeParent = true } = {}) {
    return Object.keys(this.phases)
      .filter((phase) => includeParent || phase !== 'orchestrate')
      .sort((a, b) => {
        const idxA = PHASE_ORDER.indexOf(a);
        const idxB = PHASE_ORDER.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start the workflow (returns a Promise but is typically fire-and-forget). */
  async start() {
    this.status = 'running';
    this.startedAt = new Date().toISOString();

    const activePhases = this.getSortedPhases();

    this.emit('workflow:started', {
      workflowId: this.id,
      phases: activePhases,
    });

    try {
      if (this.mode === 'parallel') {
        await this.runParallel();
      } else {
        await this.runSequential();
      }

      if (this.status === 'running') {
        this.status = 'completed';
        this.completedAt = new Date().toISOString();
        this.emit('workflow:completed', {
          workflowId: this.id,
          success: true,
        });
      }
    } catch (err) {
      if (this.status !== 'stopped') {
        this.status = 'failed';
        this.completedAt = new Date().toISOString();
        this.emit('workflow:error', {
          workflowId: this.id,
          error: err.message,
        });
      }
    } finally {
      this.deleteContextFile();
    }
  }

  /** Run phases one after another in PHASE_ORDER (with custom phases at the end). */
  async runSequential() {
    const parentAgents = this.getParentAgents();
    if (parentAgents.length > 0) {
      await this.runParentChildSequential(parentAgents);
      return;
    }

    const activePhases = this.getSortedPhases();

    for (const phaseName of activePhases) {
      if (this.status === 'stopped') return;
      const success = await this.runPhase(phaseName);
      if (!success) {
        throw new Error(`Phase failed: ${phaseName}`);
      }
    }
  }

  /** Run all populated phases concurrently. */
  async runParallel() {
    const parentAgents = this.getParentAgents();
    if (parentAgents.length > 0) {
      await this.runParentChildParallel(parentAgents);
      return;
    }

    const activePhases = this.getSortedPhases();
    const results = await Promise.all(activePhases.map((p) => this.runPhase(p)));
    if (!results.every(Boolean)) {
      throw new Error('One or more phases failed');
    }
  }

  async runParentChildSequential(parentAgents) {
    const childPhases = this.getSortedPhases({ includeParent: false });

    const planned = await this.runParentCheckpoint(parentAgents, 'plan');
    if (!planned) throw new Error('Parent orchestrator failed during planning');

    for (const phaseName of childPhases) {
      if (this.status === 'stopped') return;

      const success = await this.runPhase(phaseName);
      if (!success) throw new Error(`Phase failed: ${phaseName}`);

      const reviewed = await this.runParentCheckpoint(parentAgents, 'review', phaseName);
      if (!reviewed) throw new Error(`Parent orchestrator failed while reviewing ${phaseName}`);
    }

    const finalized = await this.runParentCheckpoint(parentAgents, 'finalize');
    if (!finalized) throw new Error('Parent orchestrator failed during finalization');
  }

  async runParentChildParallel(parentAgents) {
    const childPhases = this.getSortedPhases({ includeParent: false });

    const planned = await this.runParentCheckpoint(parentAgents, 'plan');
    if (!planned) throw new Error('Parent orchestrator failed during planning');

    const results = await Promise.all(childPhases.map((phaseName) => this.runPhase(phaseName)));
    if (!results.every(Boolean)) throw new Error('One or more child phases failed');

    const finalized = await this.runParentCheckpoint(parentAgents, 'finalize');
    if (!finalized) throw new Error('Parent orchestrator failed during finalization');
  }

  async runParentCheckpoint(parentAgents, checkpoint, childPhase = null) {
    if (this.status === 'stopped') return false;

    this.emit('phase:started', {
      workflowId: this.id,
      phase: 'orchestrate',
      checkpoint,
      childPhase,
    });

    const results = await Promise.all(
      parentAgents.map((agent) => this.runAgent(agent, 'orchestrate', {
        parentCheckpoint: checkpoint,
        childPhase,
      })),
    );
    const success = results.every(Boolean);

    this.emit('phase:completed', {
      workflowId: this.id,
      phase: 'orchestrate',
      checkpoint,
      childPhase,
      success,
    });

    return success;
  }

  /**
   * Execute a single phase – all agents assigned to this phase run concurrently.
   *
   * @param {string} phaseName
   */
  async runPhase(phaseName) {
    if (this.status === 'stopped') return;

    this.emit('phase:started', {
      workflowId: this.id,
      phase: phaseName,
    });

    const agents = this.phases[phaseName] || [];
    const results = await Promise.all(
      agents.map((agent) => this.runAgent(agent, phaseName)),
    );

    const success = results.every((r) => r);

    this.emit('phase:completed', {
      workflowId: this.id,
      phase: phaseName,
      success,
    });

    return success;
  }

  /**
   * Run a single agent inside a phase.
   *
   * @param {Object} agent     - { name, command, role }
   * @param {string} phaseName
   * @param {Object} promptContext
   * @returns {Promise<boolean>} true if the agent completed successfully
   */
  async runAgent(agent, phaseName, promptContext = {}) {
    const role = ROLES[agent.role] || { label: agent.role, description: '' };

    this.emit('agent:started', {
      workflowId: this.id,
      agent: agent.name,
      phase: phaseName,
      role: role.label,
    });

    // Initialise output accumulator for this agent
    if (!this.agentOutputs[agent.name]) {
      this.agentOutputs[agent.name] = '';
    }

    // Write current context markdown file in the workspace
    this.writeContextFile(agent);

    const prompt = this.buildPrompt(agent, phaseName, promptContext);

    // Use custom argFlag if provided, otherwise the CLI-specific pattern
    let cliArgs;
    if (agent.argFlag) {
      cliArgs = [agent.argFlag, prompt];
    } else {
      const patternFn = CLI_PATTERNS[agent.command] || ((p) => [p]);
      cliArgs = patternFn(prompt);
    }

    const executable = agent.executable || agent.command;
    const runner = new ProcessRunner(executable, cliArgs, {
      cwd: this.projectPath,
      keepStdinOpen: agent.keepStdinOpen ?? !CLOSE_STDIN_FOR_AUTO_APPROVED_CLIS.has(agent.command),
    });

    this.runners.push(runner);
    this.runnersByAgent.set(agent.name, runner);
    this.runnersByAgent.set(agent.command, runner);

    try {
      const result = await runner.run((stream, data) => {
        this.agentOutputs[agent.name] += data;
        this.emit('agent:output', {
          workflowId: this.id,
          agent: agent.name,
          command: agent.command,
          phase: phaseName,
          stream,
          data,
        });
        this.captureAgentMessages(agent, phaseName, data);
        this.detectMisleadingChildLaunchClaim(agent, phaseName, data);
        this.detectPermissionRequest(agent, phaseName, stream, data);
      });
      this.flushAgentMessageBuffer(agent, phaseName);

      const success = result.exitCode === 0;
      if (!success) {
        const failureLine = `\n[orchestrator] ${agent.name} exited with code ${result.exitCode} during ${phaseName}.\n`;
        this.agentOutputs[agent.name] += failureLine;
        this.emit('agent:output', {
          workflowId: this.id,
          agent: agent.name,
          command: agent.command,
          phase: phaseName,
          stream: 'stderr',
          data: failureLine,
        });
      }

      this.emit('agent:completed', {
        workflowId: this.id,
        agent: agent.name,
        command: agent.command,
        phase: phaseName,
        success,
        exitCode: result.exitCode,
      });

      return success;
    } catch (err) {
      this.emit('agent:completed', {
        workflowId: this.id,
        agent: agent.name,
        command: agent.command,
        phase: phaseName,
        success: false,
        exitCode: null,
        error: err.message,
      });
      const outputTail = err.output
        ? ` Last captured output: ${makeInline(stripAnsi(err.output), 2000)}`
        : '';
      const failureLine = `\n[orchestrator] ${agent.name} failed during ${phaseName}: ${err.message}.${outputTail}\n`;
      this.agentOutputs[agent.name] += failureLine;
      this.emit('agent:output', {
        workflowId: this.id,
        agent: agent.name,
        command: agent.command,
        phase: phaseName,
        stream: 'stderr',
        data: failureLine,
      });
      return false;
    } finally {
      this.flushAgentMessageBuffer(agent, phaseName);
      this.runnersByAgent.delete(agent.name);
      this.runnersByAgent.delete(agent.command);
      this.pendingPermissions.delete(agent.name);
    }
  }

  /**
   * Detect output that looks like an interactive approval prompt and notify UI clients.
   */
  detectPermissionRequest(agent, phaseName, stream, data) {
    if (this.pendingPermissions.has(agent.name)) return;
    if (!looksLikePermissionPrompt(data)) return;

    const request = {
      requestId: `${this.id}:${agent.command}:${Date.now()}:${++this.permissionRequestSeq}`,
      agent: agent.name,
      command: agent.command,
      phase: phaseName,
      stream,
      prompt: truncate(stripAnsi(data).trim(), 2000),
      choices: DEFAULT_PERMISSION_CHOICES,
    };

    this.pendingPermissions.set(agent.name, request);
    this.emit('agent:permission_requested', {
      workflowId: this.id,
      ...request,
    });
  }

  /**
   * Forward a user approval/denial response to a running agent process.
   *
   * @param {Object} input
   * @param {string} input.agent - Agent name or command.
   * @param {string} [input.requestId]
   * @param {string} input.response
   * @returns {{ok: boolean, error?: string}}
   */
  respondToPermission({ agent, requestId, response }) {
    const pending = Array.from(this.pendingPermissions.values()).find((item) => {
      const matchesAgent = !agent || item.agent === agent || item.command === agent;
      const matchesRequest = !requestId || item.requestId === requestId;
      return matchesAgent && matchesRequest;
    });

    if (!pending) {
      return { ok: false, error: 'No pending permission request matched this response.' };
    }

    const runner = this.runnersByAgent.get(pending.agent) || this.runnersByAgent.get(pending.command);
    if (!runner) {
      this.pendingPermissions.delete(pending.agent);
      return { ok: false, error: 'The agent process is no longer running.' };
    }

    const line = String(response ?? '').endsWith('\n')
      ? String(response ?? '')
      : `${String(response ?? '')}\n`;

    const sent = runner.sendInput(line);
    if (!sent) {
      return { ok: false, error: 'The agent process is not accepting input.' };
    }

    this.pendingPermissions.delete(pending.agent);
    this.emit('agent:permission_resolved', {
      workflowId: this.id,
      requestId: pending.requestId,
      agent: pending.agent,
      command: pending.command,
      phase: pending.phase,
    });

    return { ok: true };
  }

  /**
   * Write preceding agent outputs to a workspace file .agent_context.md.
   */
  writeContextFile(currentAgent = null) {
    try {
      const filePath = path.join(this.projectPath, '.agent_context.md');
      let markdown = `# Agent Orchestrator Context\n\n`;
      markdown += `This file contains the outputs, messages, and decisions of agents in the workflow. Please use this context to inform your work.\n\n`;
      if (currentAgent) {
        markdown += `## Current Agent\n${this.describeAgent(currentAgent)}\n\n`;
      }
      markdown += `## Original Task\n${this.idea}\n\n`;
      markdown += `## Workflow Mode\n${this.mode}\n\n`;
      const parentAgents = this.getParentAgents();
      const childAgents = this.getChildAgents();
      markdown += `## Workflow Topology\n`;
      markdown += `- **Parent Orchestrator:** ${parentAgents.length ? parentAgents.map((agent) => agent.name).join(', ') : 'None'}\n`;
      markdown += `- **Selected Child CLI Agents:** ${childAgents.length ? childAgents.map((agent) => this.describeAgent(agent)).join('; ') : 'None'}\n\n`;
      markdown += `## Delegation Rules\n`;
      markdown += `- The Node orchestrator service launches selected child CLI agents. Parent agents must not run, spawn, background, or wait for selected child CLI commands themselves.\n`;
      markdown += `- Parent agents must not claim a selected child CLI is running in the background unless that child already produced output in this context file.\n`;
      markdown += `- Parent agents should write CHILD TASKS, send MESSAGE TO lines, then exit the checkpoint so the orchestrator service can start the child phase.\n`;
      markdown += `- The parent orchestrator must delegate child work to selected child CLI agents first.\n`;
      markdown += `- The parent may create or use its own internal subagent only when no selected child CLI agent can reasonably own that role or task.\n`;
      markdown += `- If there is no exact role match, assign the work to the closest selected child CLI agent and label it as a fallback role match.\n`;
      markdown += `- Child agents may create their own subagents, add tools, or add skills when needed to achieve their assigned objective.\n\n`;
      markdown += `## Tools And Skills Policy\n`;
      markdown += `- Agents may add task-specific tools, dependencies, MCP servers, plugins, or skills when they are genuinely needed.\n`;
      markdown += `- Ask for approval through the CLI permission flow for installs, filesystem writes outside the project, network access, or system-level changes.\n`;
      markdown += `- Record any added tool or skill in HANDOFF with why it was needed and how to reproduce or remove it.\n\n`;
      markdown += `## Internal Subagent Reporting\n`;
      markdown += `- If you create an internal subagent, report its work with these exact one-line formats so the UI can show it live.\n`;
      markdown += `- \`SUBAGENT START [name]: objective\`\n`;
      markdown += `- \`SUBAGENT OUTPUT [name]: progress or finding\`\n`;
      markdown += `- \`SUBAGENT DONE [name]: result\`\n`;
      markdown += `- \`SUBAGENT ERROR [name]: blocker or failure\`\n\n`;
      markdown += `## Communication Rules\n`;
      markdown += `- Read this file before making decisions.\n`;
      markdown += `- Communicate with the parent and other selected CLI agents using this exact one-line format: \`MESSAGE TO [recipient]: message\`.\n`;
      markdown += `- Valid recipients include exact agent names, \`Parent Orchestrator\`, \`children\`, \`all\`, or \`role:<role-key>\` such as \`role:reviewer\`.\n`;
      markdown += `- Use messages for questions, blockers, requests for review, task results, tool/skill requests, and decisions that another agent needs.\n`;
      markdown += `- Treat earlier agent output as shared project context, not as final truth if the code disagrees.\n`;
      markdown += `- End your response with a HANDOFF section containing files changed, validation run, blockers, and advice for the next role.\n\n`;
      markdown += `## Token Optimization & Subagents\n`;
      markdown += `- Optimize your token usage. Keep outputs concise and avoid unnecessary verbosity.\n`;
      markdown += `- Collaborate and communicate with other agents to divide and conquer complex tasks.\n`;
      markdown += `- Create your own internal subagents to parallelize work and prevent exceeding your token limit.\n\n`;
      if (currentAgent) {
        const inbox = this.agentMessages.filter((message) => this.messageTargetsAgent(message, currentAgent)).slice(-25);
        markdown += `## Messages For ${currentAgent.name}\n`;
        markdown += inbox.length
          ? `${inbox.map((message) => this.formatMessage(message)).join('\n')}\n\n`
          : `*No direct or broadcast messages yet.*\n\n`;
      }
      markdown += `## Recent Team Message Log\n`;
      markdown += this.agentMessages.length
        ? `${this.agentMessages.slice(-40).map((message) => this.formatMessage(message)).join('\n')}\n\n`
        : `*No agent messages have been recorded yet.*\n\n`;
      const visibleSubagentEvents = this.internalSubagentEvents
        .filter((event) => !currentAgent || event.parentAgent === currentAgent.name || currentAgent.role === 'orchestrator')
        .slice(-40);
      markdown += `## Recent Internal Subagent Work\n`;
      markdown += visibleSubagentEvents.length
        ? `${visibleSubagentEvents.map((event) => this.formatSubagentEvent(event)).join('\n')}\n\n`
        : `*No internal subagent work has been reported yet.*\n\n`;
      markdown += `## Agent Phase Execution Details\n\n`;

      let hasPrecedingWork = false;
      for (const a of this.agents) {
        const output = this.agentOutputs[a.name];
        if (output) {
          hasPrecedingWork = true;
          const roleInfo = ROLES[a.role] || { label: a.role, description: '' };
          markdown += `### Agent: ${a.name} (${roleInfo.label})\n`;
          markdown += `- **Phase:** ${roleInfo.phase || a.role}\n`;
          markdown += `- **Status:** Completed\n\n`;
          markdown += `#### Output:\n\`\`\`\n${output.trim()}\n\`\`\`\n\n`;
          markdown += `---\n\n`;
        }
      }

      if (!hasPrecedingWork) {
        markdown += `*No preceding agent work has completed yet.*\n`;
      }

      fs.writeFileSync(filePath, markdown, 'utf8');
    } catch (err) {
      console.error('Failed to write agent context file:', err.message);
    }
  }

  /**
   * Delete the workspace context file .agent_context.md.
   */
  deleteContextFile() {
    try {
      const filePath = path.join(this.projectPath, '.agent_context.md');
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error('Failed to delete agent context file:', err.message);
    }
  }

  /**
   * Construct the instruction prompt that will be passed to the CLI agent.
   *
   * @param {Object} agent
   * @param {string} phaseName
   * @param {Object} promptContext
   * @returns {string}
   */
  buildPrompt(agent, phaseName, promptContext = {}) {
    const role = ROLES[agent.role] || { label: agent.role, description: '' };
    const responsibilities = Array.isArray(role.responsibilities)
      ? role.responsibilities.join('; ')
      : 'complete the work assigned to this role';
    const parentAgents = this.getParentAgents();
    const childAgents = this.getChildAgents();
    const childSummary = this.describeChildRoster();

    let relationshipInstruction = '';
    if (agent.role === 'orchestrator') {
      const checkpoint = promptContext.parentCheckpoint || 'plan';
      const childPhase = promptContext.childPhase || 'none';
      relationshipInstruction =
        `You are the parent orchestrator agent. Selected child CLI agents: ${childSummary}. ` +
        `Checkpoint: ${checkpoint}. Child phase under review: ${childPhase}. ` +
        `The Node orchestrator service, not you, launches selected child CLI agents after your checkpoint exits. ` +
        `Do not run, spawn, background, wait for, or claim you started selected child CLI commands such as opencode, codex, gemini, copilot, claude, or aider. ` +
        `Do not say a selected child CLI is running in the background unless its output already appears in .agent_context.md. ` +
        `You must use selected child CLI agents as your subagents before creating any internal subagent. ` +
        `For every child task, first match by exact selected role or phase. If no exact match exists, assign it to the closest selected child CLI agent and mark fallback role match. ` +
        `Only create or use your own internal subagent after stating that no selected child CLI agent is suitable. ` +
        `Write CHILD TASKS with exact selected agent names, roles, objectives, allowed tools or skills, and expected handoff. ` +
        `Use MESSAGE TO [exact child agent name] for direct instructions, MESSAGE TO [role:<role-key>] for role-level instructions, and MESSAGE TO [all] for team-wide decisions. ` +
        `After writing CHILD TASKS and HANDOFF for this checkpoint, stop and exit so the orchestrator can run the next selected CLI agent. ` +
        `Coordinate and review; do not perform child implementation work while a selected child CLI can own it. `;
    } else if (parentAgents.length > 0) {
      const parentSummary = parentAgents.map((item) => item.name).join(', ');
      relationshipInstruction =
        `You are a selected child CLI agent reporting to parent orchestrator ${parentSummary}. ` +
        `Find the CHILD TASKS item addressed to your exact agent name first; if absent, use the task for your role or closest fallback role. ` +
        `Communicate with the parent and sibling CLI agents using MESSAGE TO [recipient]: message, including blockers, requests, decisions, and review needs. ` +
        `You may create your own subagents and add task-specific tools, skills, MCP servers, plugins, or dependencies when needed to achieve your objective. ` +
        `If you create internal subagents, report them with SUBAGENT START [name]: objective, SUBAGENT OUTPUT [name]: progress, SUBAGENT DONE [name]: result, or SUBAGENT ERROR [name]: issue so their work appears in the UI. ` +
        `Request approval for external installs, network access, system changes, or writes outside the project. ` +
        `Report results back to the parent in HANDOFF with files changed, validation, blockers, tools or skills added, and recommended next task. `;
    }

    // Gather preceding agent outputs to build a safe, inline summary context
    let contextStr = '';
    const preceding = [];
    for (const a of this.agents) {
      if (a.name !== agent.name && this.agentOutputs[a.name]) {
        const cleaned = makeInline(this.agentOutputs[a.name] || '', 1000);
        if (cleaned) {
          const roleInfo = ROLES[a.role] || { label: a.role, description: '' };
          preceding.push(`[${a.name} (${roleInfo.label}): ${cleaned}]`);
        }
      }
    }

    if (preceding.length > 0) {
      contextStr = ` Preceding agent outputs: ${preceding.join(' ')} (Full untruncated details are in .agent_context.md).`;
    }

    // Keep prompt concise and single-line for CLI argument compatibility.
    // Newlines in CLI args cause issues across different shells and agents.
    return (
      `You are the ${role.label} (${role.description}). ` +
      `Phase: ${phaseName}. ` +
      `Project: ${this.projectPath}. ` +
      `Task: ${makeInline(this.idea, 2000)}. ` +
      `Your responsibilities: ${responsibilities}. ` +
      relationshipInstruction +
      `Read .agent_context.md if it exists, check your Messages section, use prior agent handoffs, send MESSAGE TO lines for any parent or peer communication, report internal subagent work with SUBAGENT lines, add tools or skills only when useful for the task, and end with HANDOFF: files changed, validation, blockers, tools or skills added, next advice. ` +
      `CRITICAL: Optimize your token usage by keeping outputs concise. Communicate with other agents and create internal subagents to collaborate and prevent exceeding your token limit.` +
      contextStr
    );
  }

  // -----------------------------------------------------------------------
  // Control
  // -----------------------------------------------------------------------

  /** Gracefully stop the workflow and kill all running processes. */
  stop() {
    this.status = 'stopped';
    this.completedAt = new Date().toISOString();

    for (const runner of this.runners) {
      runner.kill();
    }
    this.pendingPermissions.clear();
    this.runnersByAgent.clear();

    this.deleteContextFile();

    this.emit('workflow:stopped', { workflowId: this.id });
  }

  /**
   * Return a serialisable snapshot of the workflow's current state.
   */
  getStatus() {
    return {
      id: this.id,
      status: this.status,
      mode: this.mode,
      projectPath: this.projectPath,
      idea: this.idea,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      pendingPermissions: Array.from(this.pendingPermissions.values()),
      messages: this.agentMessages.slice(-100),
      internalSubagentEvents: this.internalSubagentEvents.slice(-100),
      agents: this.agents.map((a) => ({
        name: a.name,
        command: a.command,
        executable: a.executable,
        role: a.role,
        output: this.agentOutputs[a.name] || '',
      })),
      phases: Object.keys(this.phases)
        .sort((a, b) => {
          const idxA = PHASE_ORDER.indexOf(a);
          const idxB = PHASE_ORDER.indexOf(b);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          return 0;
        })
        .map((p) => ({
          name: p,
          agents: (this.phases[p] || []).map((a) => a.name),
        })),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator – manages multiple workflows
// ---------------------------------------------------------------------------

class Orchestrator {
  constructor() {
    /** @type {Map<string, Workflow>} */
    this.workflows = new Map();
  }

  /**
   * Create (but do not start) a new workflow.
   *
   * @param {Object} config - Same shape as the Workflow constructor config
   *                          minus the `id` field (auto-generated).
   * @returns {Workflow}
   */
  createWorkflow(config) {
    const id = config.id || crypto.randomUUID();
    const workflow = new Workflow({ id, ...config });
    this.workflows.set(id, workflow);
    return workflow;
  }

  /**
   * Retrieve a workflow by its ID.
   *
   * @param {string} id
   * @returns {Workflow|undefined}
   */
  getWorkflow(id) {
    return this.workflows.get(id);
  }

  /**
   * Return status snapshots for every workflow ever created.
   *
   * @returns {Array<Object>}
   */
  getHistory() {
    return Array.from(this.workflows.values()).map((w) => w.getStatus());
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { Orchestrator, Workflow, ROLES, PHASE_ORDER, CLI_PATTERNS };
