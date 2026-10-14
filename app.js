/**
 * App – Express + WebSocket Server
 *
 * Serves the static SPA from public/, exposes a REST API for agent detection
 * and workflow management, and relays real-time workflow events over WebSocket.
 */

'use strict';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const { detectAgents } = require('./lib/agent-detector');
const { Orchestrator } = require('./lib/orchestrator');

// ---------------------------------------------------------------------------
// Express + HTTP + WebSocket setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const orchestrator = new Orchestrator();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse JSON bodies
app.use(express.json());

// CORS headers for development convenience
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Serve static assets from the public/ directory
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// WebSocket connection management
// ---------------------------------------------------------------------------

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('close', () => {
    clients.delete(ws);
  });
});

/**
 * Broadcast a JSON message to every connected WebSocket client.
 *
 * @param {Object} data - Payload to send (will be JSON-stringified).
 */
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(json);
    }
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/agents/detect', async (req, res) => {
  try {
    let customAgents = [];
    if (req.query.custom) {
      try {
        customAgents = JSON.parse(req.query.custom);
      } catch (e) {
        // ignore
      }
    }
    const agents = await detectAgents(customAgents);
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: 'Failed to detect agents', details: err.message });
  }
});

/**
 * POST /api/workflow/start
 * Create and start a new orchestration workflow.
 *
 * Body: { agents: [{name, command, role}], projectPath, idea, mode }
 */
app.post('/api/workflow/start', (req, res) => {
  try {
    const { id, agents, projectPath, idea, mode } = req.body;

    // -- Validation --------------------------------------------------------
    if (!agents || !Array.isArray(agents) || agents.length === 0) {
      return res.status(400).json({ error: 'At least one agent is required.' });
    }

    if (!projectPath || typeof projectPath !== 'string') {
      return res.status(400).json({ error: 'projectPath is required.' });
    }

    if (!fs.existsSync(projectPath)) {
      return res.status(400).json({ error: `projectPath does not exist: ${projectPath}` });
    }

    if (!idea || typeof idea !== 'string') {
      return res.status(400).json({ error: 'idea is required.' });
    }

    // -- Create workflow ---------------------------------------------------
    const workflow = orchestrator.createWorkflow({
      id,
      agents,
      projectPath,
      idea,
      mode: mode || 'sequential',
    });

    // -- Wire workflow events to WebSocket broadcast -----------------------
    wireWorkflowEvents(workflow);

    // Start the workflow (fire-and-forget – status is tracked internally)
    workflow.start();

    res.json({ id: workflow.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start workflow', details: err.message });
  }
});

/**
 * GET /api/workflow/status/:id
 * Return the current status of a workflow.
 */
app.get('/api/workflow/status/:id', (req, res) => {
  const workflow = orchestrator.getWorkflow(req.params.id);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found.' });
  }
  res.json(workflow.getStatus());
});

/**
 * GET /api/workflow/history
 * Return status snapshots for all workflows.
 */
app.get('/api/workflow/history', (_req, res) => {
  res.json(orchestrator.getHistory());
});

/**
 * POST /api/workflow/:id/stop
 * Stop a running workflow.
 */
app.post('/api/workflow/:id/stop', (req, res) => {
  const workflow = orchestrator.getWorkflow(req.params.id);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found.' });
  }

  try {
    workflow.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop workflow', details: err.message });
  }
});

/**
 * POST /api/workflow/:id/input
 * Send user input to a running agent process, usually to answer an approval prompt.
 *
 * Body: { agent, requestId, response }
 */
app.post('/api/workflow/:id/input', (req, res) => {
  const workflow = orchestrator.getWorkflow(req.params.id);
  if (!workflow) {
    return res.status(404).json({ error: 'Workflow not found.' });
  }

  const { agent, requestId, response } = req.body || {};
  if (typeof response !== 'string') {
    return res.status(400).json({ error: 'response is required.' });
  }

  const result = workflow.respondToPermission({ agent, requestId, response });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ ok: true });
});

// Catch-all: serve index.html for SPA client-side routing (Express 5 syntax)
app.get('{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wire all relevant events from a Workflow instance to the WebSocket
 * broadcast function so connected clients receive live updates.
 *
 * @param {import('./lib/orchestrator').Workflow} workflow
 */
function wireWorkflowEvents(workflow) {
  workflow.on('workflow:started', (data) => {
    broadcast({ type: 'workflow:started', ...data });
  });

  workflow.on('phase:started', (data) => {
    broadcast({ type: 'phase:started', ...data });
  });

  workflow.on('phase:completed', (data) => {
    broadcast({ type: 'phase:completed', ...data });
  });

  workflow.on('agent:started', (data) => {
    broadcast({ type: 'agent:started', ...data });
  });

  workflow.on('agent:output', (data) => {
    broadcast({ type: 'agent:output', ...data });
  });

  workflow.on('agent:message', (data) => {
    broadcast({ type: 'agent:message', ...data });
  });

  workflow.on('agent:subagent_event', (data) => {
    broadcast({ type: 'agent:subagent_event', ...data });
  });

  workflow.on('agent:permission_requested', (data) => {
    broadcast({ type: 'agent:permission_requested', ...data });
  });

  workflow.on('agent:permission_resolved', (data) => {
    broadcast({ type: 'agent:permission_resolved', ...data });
  });

  workflow.on('agent:completed', (data) => {
    broadcast({ type: 'agent:completed', ...data });
  });

  workflow.on('workflow:completed', (data) => {
    broadcast({ type: 'workflow:completed', ...data });
  });

  workflow.on('workflow:error', (data) => {
    broadcast({ type: 'workflow:error', ...data });
  });

  workflow.on('workflow:stopped', (data) => {
    broadcast({ type: 'workflow:stopped', ...data });
  });
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`✦ Agent Orchestrator running at http://localhost:${PORT}`);

  // Attempt to open the browser automatically (non-critical)
  import('open')
    .then((mod) => mod.default(`http://localhost:${PORT}`))
    .catch(() => {
      // 'open' package not installed – no big deal
    });
});
