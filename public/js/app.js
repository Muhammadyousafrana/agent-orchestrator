/**
 * Agent Orchestrator — Client Application
 *
 * Handles agent detection, role assignment, workflow launch,
 * real-time monitoring via WebSocket, and UI state management.
 */

(function () {
  'use strict';

  // =========================================================================
  // Constants
  // =========================================================================

  const ROLES = [
    { key: 'orchestrator', label: 'Parent Orchestrator', icon: '◎' },
    { key: 'architect',  label: 'System Architect',  icon: '🏗️' },
    { key: 'builder',    label: 'Feature Builder',    icon: '🔨' },
    { key: 'tester',     label: 'Tester',             icon: '🧪' },
    { key: 'reviewer',   label: 'Code Reviewer',      icon: '🔍' },
    { key: 'integrator', label: 'Integrator',         icon: '🔗' },
  ];

  const MODE_HINTS = {
    sequential: 'Agents work one phase at a time: Design → Build → Test → Review → Integrate',
    parallel: 'All agents work simultaneously on their assigned roles',
  };

  const TOAST_ICONS = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  };

  // =========================================================================
  // State
  // =========================================================================

  const state = {
    agents: [],
    selectedAgents: new Set(),
    roleAssignments: new Map(),
    projectPath: '',
    idea: '',
    mode: 'sequential',
    currentWorkflow: null,
    currentStep: 1,
    timerInterval: null,
    timerStart: null,
    customAgents: [],
    pendingPermissions: [],
    activePermission: null,
  };

  // =========================================================================
  // DOM References
  // =========================================================================

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    toastContainer: $('#toast-container'),
    themeToggle: $('#theme-toggle'),
    setupPanel: $('#setup-panel'),
    workflowPanel: $('#workflow-panel'),
    agentsGrid: $('#agents-grid'),
    roleAssignments: $('#role-assignments'),
    projectPath: $('#project-path'),
    ideaInput: $('#idea-input'),
    modeHint: $('#mode-hint'),
    workflowTitle: $('#workflow-title'),
    workflowInfo: $('#workflow-info'),
    workflowTimer: $('#workflow-timer'),
    phaseTimeline: $('#phase-timeline'),
    agentOutputs: $('#agent-outputs'),
    historyList: $('#history-list'),
    historyToggle: $('#history-toggle'),
    btnRefresh: $('#btn-refresh-agents'),
    btnStep1Next: $('#btn-step1-next'),
    btnStep2Back: $('#btn-step2-back'),
    btnStep2Next: $('#btn-step2-next'),
    btnStep3Back: $('#btn-step3-back'),
    btnLaunch: $('#btn-launch'),
    btnStop: $('#btn-stop-workflow'),
    btnNewWorkflow: $('#btn-new-workflow'),
    customAgentName: $('#custom-agent-name'),
    customAgentCmd: $('#custom-agent-cmd'),
    customAgentFlag: $('#custom-agent-flag'),
    btnAddCustomAgent: $('#btn-add-custom-agent'),
    permissionModal: $('#permission-modal'),
    permissionAgent: $('#permission-agent'),
    permissionPrompt: $('#permission-prompt'),
    permissionCustomInput: $('#permission-custom-input'),
    btnPermissionDeny: $('#btn-permission-deny'),
    btnPermissionSendCustom: $('#btn-permission-send-custom'),
    btnPermissionAllowAll: $('#btn-permission-allow-all'),
    btnPermissionAllowOnce: $('#btn-permission-allow-once'),
  };

  // =========================================================================
  // WebSocket
  // =========================================================================

  let ws = null;
  let wsReconnectDelay = 1000;

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      return;
    }

    ws.onopen = () => {
      wsReconnectDelay = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) { /* ignore malformed */ }
    };

    ws.onclose = () => {
      ws = null;
      setTimeout(connectWebSocket, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
    };

    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  function handleWsMessage(msg) {
    if (!state.currentWorkflow) return;
    if (msg.workflowId && msg.workflowId !== state.currentWorkflow) return;

    switch (msg.type) {
      case 'workflow:started':
        showToast('Workflow started', 'info');
        break;

      case 'phase:started':
        updatePhaseState(msg.phase, 'running');
        break;

      case 'phase:completed':
        updatePhaseState(msg.phase, msg.success ? 'completed' : 'failed');
        break;

      case 'agent:started':
        updateAgentStatus(msg.agent, 'running');
        break;

      case 'agent:output':
        appendOutput(msg.agent, msg.data, msg.stream);
        break;

      case 'agent:message':
        appendAgentMessage(msg);
        break;

      case 'agent:subagent_event':
        appendSubagentEvent(msg);
        break;

      case 'agent:permission_requested':
        queuePermissionRequest(msg);
        break;

      case 'agent:permission_resolved':
        resolvePermissionRequest(msg.requestId);
        break;

      case 'agent:completed':
        updateAgentStatus(msg.agent, msg.success ? 'success' : 'failed');
        break;

      case 'workflow:completed':
        dom.workflowTitle.textContent = 'Workflow Complete';
        stopTimer();
        clearPermissionRequests();
        dom.btnStop.classList.add('hidden');
        dom.btnNewWorkflow.classList.remove('hidden');
        showToast('Workflow completed successfully!', 'success');
        loadHistory();
        break;

      case 'workflow:error':
        dom.workflowTitle.textContent = 'Workflow Failed';
        stopTimer();
        clearPermissionRequests();
        dom.btnStop.classList.add('hidden');
        dom.btnNewWorkflow.classList.remove('hidden');
        showToast(`Workflow error: ${msg.error}`, 'error');
        loadHistory();
        break;

      case 'workflow:stopped':
        dom.workflowTitle.textContent = 'Workflow Stopped';
        stopTimer();
        clearPermissionRequests();
        dom.btnStop.classList.add('hidden');
        dom.btnNewWorkflow.classList.remove('hidden');
        showToast('Workflow stopped', 'warning');
        loadHistory();
        break;
    }
  }

  // =========================================================================
  // Agent Detection
  // =========================================================================

  async function detectAgents() {
    // Show shimmer loading
    dom.agentsGrid.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const shimmer = document.createElement('div');
      shimmer.className = 'shimmer-card';
      dom.agentsGrid.appendChild(shimmer);
    }
    dom.btnStep1Next.disabled = true;
    state.selectedAgents.clear();

    try {
      const customParam = encodeURIComponent(JSON.stringify(state.customAgents));
      const res = await fetch(`/api/agents/detect?custom=${customParam}`);
      if (!res.ok) throw new Error('Detection failed');
      const data = await res.json();
      state.agents = data.agents || [];
      renderAgentCards();
    } catch (err) {
      dom.agentsGrid.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'agents-loading';
      msg.textContent = 'Failed to detect agents. Is the server running?';
      dom.agentsGrid.appendChild(msg);
      showToast('Failed to detect agents', 'error');
    }
  }

  function renderAgentCards() {
    dom.agentsGrid.innerHTML = '';

    state.agents.forEach((agent) => {
      const card = document.createElement('div');
      card.className = 'agent-card' + (!agent.installed ? ' disabled' : '');
      card.style.setProperty('--agent-color', agent.color);
      card.dataset.command = agent.command;

      // Header row: icon + name + toggle
      const header = document.createElement('div');
      header.className = 'agent-card-header';

      const iconName = document.createElement('div');
      iconName.className = 'agent-icon-name';

      const icon = document.createElement('div');
      icon.className = 'agent-icon';
      icon.textContent = agent.icon;
      icon.style.color = agent.color;

      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = agent.name;

      iconName.appendChild(icon);
      iconName.appendChild(name);

      // Toggle switch
      const toggle = document.createElement('label');
      toggle.className = 'toggle-switch';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = !agent.installed;
      checkbox.id = `toggle-${agent.command}`;
      const slider = document.createElement('span');
      slider.className = 'toggle-slider';
      toggle.appendChild(checkbox);
      toggle.appendChild(slider);

      header.appendChild(iconName);

      // Delete button for custom agents
      if (agent.custom) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-delete-agent';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = 'Remove custom agent';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Remove custom agent "${agent.name}"?`)) {
            removeCustomAgent(agent.command);
          }
        });
        header.appendChild(deleteBtn);
      }

      header.appendChild(toggle);

      // Description
      const desc = document.createElement('div');
      desc.className = 'agent-description';
      desc.textContent = agent.description;

      // Status row
      const statusRow = document.createElement('div');
      statusRow.className = 'agent-status';

      const badge = document.createElement('span');
      badge.className = 'status-badge ' + (agent.installed ? 'installed' : 'not-found');
      const dot = document.createElement('span');
      dot.className = 'status-badge-dot';
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(agent.installed ? 'Installed' : 'Not Found'));

      statusRow.appendChild(badge);

      card.appendChild(header);
      card.appendChild(desc);
      card.appendChild(statusRow);

      // Click handler for the whole card
      if (agent.installed) {
        card.addEventListener('click', (e) => {
          // Don't double-trigger from the toggle
          if (e.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          toggleAgent(agent, checkbox.checked, card);
        });
        checkbox.addEventListener('change', () => {
          toggleAgent(agent, checkbox.checked, card);
        });
      }

      dom.agentsGrid.appendChild(card);
    });
  }

  function toggleAgent(agent, selected, card) {
    if (selected) {
      state.selectedAgents.add(agent.command);
      card.classList.add('selected');
    } else {
      state.selectedAgents.delete(agent.command);
      card.classList.remove('selected');
    }
    dom.btnStep1Next.disabled = state.selectedAgents.size === 0;
  }

  // =========================================================================
  // Role Assignment
  // =========================================================================

  function renderRoleAssignments() {
    dom.roleAssignments.innerHTML = '';
    state.roleAssignments.clear();

    const selectedList = state.agents.filter((a) => state.selectedAgents.has(a.command));
    const defaultRoles = selectedList.length > 1
      ? ['orchestrator', 'builder', 'tester', 'reviewer', 'integrator', 'architect']
      : ['builder'];

    selectedList.forEach((agent, idx) => {
      const defaultRole = defaultRoles[idx % defaultRoles.length];
      state.roleAssignments.set(agent.command, defaultRole);

      const row = document.createElement('div');
      row.className = 'role-row';

      // Agent info
      const info = document.createElement('div');
      info.className = 'role-agent-info';

      const icon = document.createElement('div');
      icon.className = 'agent-icon';
      icon.textContent = agent.icon;
      icon.style.color = agent.color;

      const name = document.createElement('span');
      name.className = 'agent-name';
      name.textContent = agent.name;

      info.appendChild(icon);
      info.appendChild(name);

      // Role controls container
      const controls = document.createElement('div');
      controls.className = 'role-controls';

      // Role dropdown
      const select = document.createElement('select');
      select.className = 'role-select';
      select.id = `role-${agent.command}`;

      ROLES.forEach((role) => {
        const opt = document.createElement('option');
        opt.value = role.key;
        opt.textContent = `${role.icon} ${role.label}`;
        if (role.key === defaultRole) opt.selected = true;
        select.appendChild(opt);
      });

      // Custom option
      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = '✏️ Custom Role...';
      select.appendChild(customOpt);

      // Custom role text input
      const customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'custom-role-input hidden';
      customInput.placeholder = 'Enter custom role name (e.g. DevOps)';
      customInput.id = `custom-role-input-${agent.command}`;

      select.addEventListener('change', () => {
        if (select.value === 'custom') {
          customInput.classList.remove('hidden');
          customInput.focus();
          state.roleAssignments.set(agent.command, customInput.value.trim() || 'custom');
        } else {
          customInput.classList.add('hidden');
          state.roleAssignments.set(agent.command, select.value);
        }
      });

      customInput.addEventListener('input', () => {
        state.roleAssignments.set(agent.command, customInput.value.trim() || 'custom');
      });

      controls.appendChild(select);
      controls.appendChild(customInput);

      row.appendChild(info);
      row.appendChild(controls);
      dom.roleAssignments.appendChild(row);
    });
  }

  // =========================================================================
  // Wizard Navigation
  // =========================================================================

  function goToStep(step) {
    state.currentStep = step;

    // Update step indicators
    $$('.wizard-step').forEach((el) => {
      const s = parseInt(el.dataset.step);
      el.classList.remove('active', 'completed');
      if (s === step) el.classList.add('active');
      else if (s < step) el.classList.add('completed');
    });

    // Update connector lines
    const line1 = $('#wizard-line-1');
    const line2 = $('#wizard-line-2');
    line1.classList.toggle('active', step >= 2);
    line2.classList.toggle('active', step >= 3);

    // Show correct step content
    $$('.step-content').forEach((el) => el.classList.remove('active'));
    $(`#step-${step}`).classList.add('active');

    // Populate step content if needed
    if (step === 2) renderRoleAssignments();
  }

  // =========================================================================
  // Workflow Launch
  // =========================================================================

  async function launchWorkflow() {
    const projectPath = dom.projectPath.value.trim();
    const idea = dom.ideaInput.value.trim();

    if (!projectPath) {
      showToast('Please enter a project folder path', 'warning');
      dom.projectPath.focus();
      return;
    }
    if (!idea) {
      showToast('Please describe your idea', 'warning');
      dom.ideaInput.focus();
      return;
    }

    // Build agent config
    // Build agent config
    const agents = [];
    let hasInvalidCustomRole = false;
    let invalidAgentName = '';

    state.roleAssignments.forEach((role, command) => {
      const agentInfo = state.agents.find((a) => a.command === command);
      if (agentInfo) {
        if (!role || role === 'custom') {
          hasInvalidCustomRole = true;
          invalidAgentName = agentInfo.name;
          return;
        }
        agents.push({
          name: agentInfo.name,
          command,
          executable: agentInfo.path || undefined,
          role,
          argFlag: agentInfo.argFlag || undefined,
        });
      }
    });

    if (hasInvalidCustomRole) {
      showToast(`Please specify a custom role name for ${invalidAgentName}`, 'warning');
      const agentCmd = state.agents.find(a => a.name === invalidAgentName).command;
      const inputEl = $(`#custom-role-input-${agentCmd}`);
      if (inputEl) inputEl.focus();
      return;
    }

    dom.btnLaunch.disabled = true;
    dom.btnLaunch.textContent = 'Launching...';

    // Generate workflowId client-side to prevent WebSocket race condition
    const workflowId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'wf-' + Math.random().toString(36).substring(2, 15) + '-' + Date.now().toString(36);

    state.currentWorkflow = workflowId;

    // Switch to workflow panel immediately so terminal elements are ready for WebSocket events
    dom.setupPanel.classList.add('hidden');
    dom.workflowPanel.classList.remove('hidden');

    // Set info
    dom.workflowTitle.textContent = 'Workflow Running';
    dom.workflowInfo.textContent = `${idea.substring(0, 80)}${idea.length > 80 ? '...' : ''} · ${state.mode} mode`;
    dom.btnStop.classList.remove('hidden');
    dom.btnNewWorkflow.classList.add('hidden');

    // Build phase timeline
    const phases = [];
    state.roleAssignments.forEach((role) => {
      const phaseMap = { orchestrator: 'orchestrate', architect: 'design', builder: 'build', tester: 'test', reviewer: 'review', integrator: 'integrate' };
      const phase = phaseMap[role] || role;
      if (!phases.includes(phase)) phases.push(phase);
    });
    // Sort by standard order with custom roles at the end to match backend sorting
    const order = ['orchestrate', 'design', 'build', 'test', 'review', 'integrate'];
    phases.sort((a, b) => {
      const idxA = order.indexOf(a);
      const idxB = order.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return 0;
    });
    renderTimeline(phases);

    // Build agent output terminals
    renderAgentTerminals(agents);

    // Start timer
    startTimer();

    try {
      const res = await fetch('/api/workflow/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: workflowId,
          agents,
          projectPath,
          idea,
          mode: state.mode,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Launch failed');
      }

    } catch (err) {
      showToast(err.message, 'error');
      // Revert UI to setup state since launch failed
      state.currentWorkflow = null;
      stopTimer();
      dom.workflowPanel.classList.add('hidden');
      dom.setupPanel.classList.remove('hidden');
    } finally {
      dom.btnLaunch.disabled = false;
      dom.btnLaunch.textContent = '🚀 Launch Workflow';
    }
  }

  // =========================================================================
  // Phase Timeline
  // =========================================================================

  function renderTimeline(phases) {
    dom.phaseTimeline.innerHTML = '';
    const phaseIcons = {
      orchestrate: '◎',
      design: '📐', build: '🔨', test: '🧪', review: '🔍', integrate: '🔗',
    };

    phases.forEach((phase, idx) => {
      if (idx > 0) {
        const connector = document.createElement('div');
        connector.className = 'phase-connector';
        connector.id = `connector-${idx}`;
        dom.phaseTimeline.appendChild(connector);
      }

      const node = document.createElement('div');
      node.className = 'phase-node';
      node.id = `phase-node-${phase}`;

      const circle = document.createElement('div');
      circle.className = 'phase-circle';
      circle.textContent = phaseIcons[phase] || '●';

      const label = document.createElement('div');
      label.className = 'phase-label';
      label.textContent = phase;

      node.appendChild(circle);
      node.appendChild(label);
      dom.phaseTimeline.appendChild(node);
    });
  }

  function updatePhaseState(phase, stateStr) {
    const node = $(`#phase-node-${phase}`);
    if (!node) return;

    node.classList.remove('running', 'completed', 'failed');
    node.classList.add(stateStr);

    if (stateStr === 'running') {
      const circle = node.querySelector('.phase-circle');
      if (circle) circle.textContent = phase === 'orchestrate' ? '◎' : '●';
    } else if (stateStr === 'completed') {
      const circle = node.querySelector('.phase-circle');
      if (circle) circle.textContent = '✓';
    } else if (stateStr === 'failed') {
      const circle = node.querySelector('.phase-circle');
      if (circle) circle.textContent = '✗';
    }
  }

  // =========================================================================
  // Agent Output Terminals
  // =========================================================================

  function renderAgentTerminals(agents) {
    dom.agentOutputs.innerHTML = '';

    agents.forEach((agent) => {
      const agentInfo = state.agents.find((a) => a.command === agent.command);
      const roleInfo = ROLES.find((r) => r.key === agent.role);

      const card = document.createElement('div');
      card.className = 'terminal-card';
      card.id = `terminal-${agent.command}`;

      // Header
      const header = document.createElement('div');
      header.className = 'terminal-header';

      const info = document.createElement('div');
      info.className = 'terminal-agent-info';

      const icon = document.createElement('div');
      icon.className = 'terminal-agent-icon';
      icon.textContent = agentInfo ? agentInfo.icon : '●';
      icon.style.color = agentInfo ? agentInfo.color : '#888';

      const name = document.createElement('span');
      name.className = 'terminal-agent-name';
      name.textContent = agent.name;

      const roleBadge = document.createElement('span');
      roleBadge.className = 'terminal-role-badge';
      roleBadge.textContent = roleInfo ? roleInfo.label : agent.role;

      info.appendChild(icon);
      info.appendChild(name);
      info.appendChild(roleBadge);

      const statusArea = document.createElement('div');
      statusArea.className = 'terminal-status';
      statusArea.id = `status-${agent.command}`;

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      dot.id = `dot-${agent.command}`;

      const statusText = document.createElement('span');
      statusText.id = `status-text-${agent.command}`;
      statusText.textContent = 'Waiting';

      statusArea.appendChild(dot);
      statusArea.appendChild(statusText);

      header.appendChild(info);
      header.appendChild(statusArea);

      // Terminal body
      const body = document.createElement('div');
      body.className = 'terminal-body';
      body.id = `output-${agent.command}`;

      card.appendChild(header);
      card.appendChild(body);
      dom.agentOutputs.appendChild(card);
    });
  }

  function updateAgentStatus(agentName, statusStr) {
    // Find the agent by name
    const agent = state.agents.find((a) => a.name === agentName);
    if (!agent) return;

    const dot = $(`#dot-${agent.command}`);
    const text = $(`#status-text-${agent.command}`);
    if (!dot || !text) return;

    dot.className = 'status-dot ' + statusStr;
    const labels = { running: 'Running', success: 'Done', failed: 'Failed' };
    text.textContent = labels[statusStr] || statusStr;
  }

  function appendOutput(agentName, data, stream) {
    const agent = state.agents.find((a) => a.name === agentName);
    if (!agent) return;

    const body = $(`#output-${agent.command}`);
    if (!body) return;

    // Escape HTML for safety
    const escaped = escapeHtml(data);

    if (stream === 'stderr') {
      const span = document.createElement('span');
      span.className = 'stderr';
      span.textContent = data;
      body.appendChild(span);
    } else {
      body.appendChild(document.createTextNode(data));
    }

    // Trim to prevent memory issues (keep last ~50KB)
    if (body.textContent.length > 50000) {
      const text = body.textContent;
      body.textContent = text.slice(-40000);
    }

    // Auto-scroll
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function appendAgentMessage(message) {
    if (!message || !message.from) return;
    const line = `\n[message -> ${message.to}] ${message.body}\n`;
    appendOutput(message.from, line, 'stdout');
  }

  function appendSubagentEvent(event) {
    if (!event || !event.parentAgent) return;
    const label = `${event.subagent || 'subagent'} ${event.status || 'output'}`;
    const line = `\n[subagent: ${label}] ${event.body || ''}\n`;
    appendOutput(event.parentAgent, line, event.status === 'error' ? 'stderr' : 'stdout');
  }

  // =========================================================================
  // Permission Prompt Handling
  // =========================================================================

  function queuePermissionRequest(request) {
    if (!request || !request.requestId) return;

    const alreadyQueued = state.pendingPermissions.some((item) => item.requestId === request.requestId);
    const alreadyActive = state.activePermission && state.activePermission.requestId === request.requestId;
    if (alreadyQueued || alreadyActive) return;

    state.pendingPermissions.push(request);
    showToast(`${request.agent} is waiting for permission`, 'warning');
    showNextPermissionRequest();
  }

  function showNextPermissionRequest() {
    if (state.activePermission || state.pendingPermissions.length === 0) {
      if (!state.activePermission && state.pendingPermissions.length === 0) {
        dom.permissionModal.classList.add('hidden');
      }
      return;
    }

    state.activePermission = state.pendingPermissions.shift();
    renderPermissionModal();
  }

  function renderPermissionModal() {
    const request = state.activePermission;
    if (!request) {
      dom.permissionModal.classList.add('hidden');
      return;
    }

    dom.permissionAgent.textContent = `${request.agent} (${request.command}) · ${request.phase} phase`;
    dom.permissionPrompt.textContent = request.prompt || 'The agent is waiting for input.';
    dom.permissionCustomInput.value = '';
    setPermissionButtonsDisabled(false);
    dom.permissionModal.classList.remove('hidden');
    setTimeout(() => dom.btnPermissionAllowOnce.focus(), 0);
  }

  function resolvePermissionRequest(requestId) {
    state.pendingPermissions = state.pendingPermissions.filter((item) => item.requestId !== requestId);
    if (state.activePermission && state.activePermission.requestId === requestId) {
      state.activePermission = null;
      dom.permissionModal.classList.add('hidden');
      showNextPermissionRequest();
    }
  }

  function clearPermissionRequests() {
    state.pendingPermissions = [];
    state.activePermission = null;
    dom.permissionModal.classList.add('hidden');
  }

  function setPermissionButtonsDisabled(disabled) {
    [
      dom.btnPermissionDeny,
      dom.btnPermissionSendCustom,
      dom.btnPermissionAllowAll,
      dom.btnPermissionAllowOnce,
    ].forEach((button) => {
      button.disabled = disabled;
    });
  }

  async function sendPermissionResponse(response) {
    const request = state.activePermission;
    if (!request || !state.currentWorkflow) return;

    setPermissionButtonsDisabled(true);
    try {
      const res = await fetch(`/api/workflow/${state.currentWorkflow}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: request.command,
          requestId: request.requestId,
          response,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send permission response');
      }

      showToast('Permission response sent', 'success');
      resolvePermissionRequest(request.requestId);
    } catch (err) {
      showToast(err.message, 'error');
      setPermissionButtonsDisabled(false);
    }
  }

  function sendCustomPermissionResponse() {
    const value = dom.permissionCustomInput.value;
    if (!value.trim()) {
      showToast('Enter a custom response first', 'warning');
      dom.permissionCustomInput.focus();
      return;
    }
    sendPermissionResponse(value);
  }

  // =========================================================================
  // Timer
  // =========================================================================

  function startTimer() {
    state.timerStart = Date.now();
    state.timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function updateTimer() {
    if (!state.timerStart) return;
    const elapsed = Math.floor((Date.now() - state.timerStart) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    dom.workflowTimer.textContent = `${m}:${s}`;
  }

  // =========================================================================
  // Toast Notifications
  // =========================================================================

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;

    const text = document.createElement('span');
    text.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(text);
    dom.toastContainer.appendChild(toast);

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // =========================================================================
  // Theme Toggle
  // =========================================================================

  function initTheme() {
    const saved = localStorage.getItem('agent-orchestrator-theme') || 'dark';
    document.body.dataset.theme = saved;
    dom.themeToggle.textContent = saved === 'dark' ? '🌙' : '☀️';
  }

  function toggleTheme() {
    const current = document.body.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    dom.themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('agent-orchestrator-theme', next);
  }

  // =========================================================================
  // History
  // =========================================================================

  async function loadHistory() {
    try {
      const res = await fetch('/api/workflow/history');
      if (!res.ok) return;
      const data = await res.json();
      renderHistory(data);
    } catch (e) { /* silent */ }
  }

  function renderHistory(workflows) {
    dom.historyList.innerHTML = '';

    if (!workflows || workflows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-muted';
      empty.textContent = 'No previous workflows';
      dom.historyList.appendChild(empty);
      return;
    }

    workflows.reverse().forEach((wf) => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const time = document.createElement('span');
      time.className = 'history-time';
      time.textContent = wf.startedAt ? new Date(wf.startedAt).toLocaleString() : '—';

      const idea = document.createElement('span');
      idea.className = 'history-idea';
      idea.textContent = wf.idea || 'No description';

      const status = document.createElement('span');
      status.className = `history-status ${wf.status}`;
      status.textContent = wf.status;

      item.appendChild(time);
      item.appendChild(idea);
      item.appendChild(status);
      dom.historyList.appendChild(item);
    });
  }

  // =========================================================================
  // Stop & Reset
  // =========================================================================

  async function stopWorkflow() {
    if (!state.currentWorkflow) return;
    if (!confirm('Are you sure you want to stop the workflow?')) return;

    try {
      await fetch(`/api/workflow/${state.currentWorkflow}/stop`, { method: 'POST' });
    } catch (e) {
      showToast('Failed to stop workflow', 'error');
    }
  }

  function resetToSetup() {
    state.currentWorkflow = null;
    stopTimer();

    dom.workflowPanel.classList.add('hidden');
    dom.setupPanel.classList.remove('hidden');

    // Reset to step 1
    goToStep(1);
    state.selectedAgents.clear();
    state.roleAssignments.clear();
    clearPermissionRequests();
    dom.projectPath.value = '';
    dom.ideaInput.value = '';

    // Re-render agent cards (clear selections)
    renderAgentCards();
    loadHistory();
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function removeCustomAgent(cmd) {
    state.customAgents = state.customAgents.filter((a) => a.command !== cmd);
    state.selectedAgents.delete(cmd);
    try {
      localStorage.setItem('agent-orchestrator-custom-agents', JSON.stringify(state.customAgents));
    } catch (e) {
      // ignore
    }
    showToast('Removed custom agent', 'info');
    detectAgents();
  }

  // =========================================================================
  // Event Wiring
  // =========================================================================

  function wireEvents() {
    // Theme
    dom.themeToggle.addEventListener('click', toggleTheme);

    // Refresh agents
    dom.btnRefresh.addEventListener('click', detectAgents);

    // Wizard navigation
    dom.btnStep1Next.addEventListener('click', () => goToStep(2));
    dom.btnStep2Back.addEventListener('click', () => goToStep(1));
    dom.btnStep2Next.addEventListener('click', () => goToStep(3));
    dom.btnStep3Back.addEventListener('click', () => goToStep(2));

    // Launch
    dom.btnLaunch.addEventListener('click', launchWorkflow);

    // Mode toggle
    $$('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        dom.modeHint.textContent = MODE_HINTS[state.mode];
      });
    });

    // Workflow controls
    dom.btnStop.addEventListener('click', stopWorkflow);
    dom.btnNewWorkflow.addEventListener('click', resetToSetup);

    // Permission prompt controls
    dom.btnPermissionAllowOnce.addEventListener('click', () => sendPermissionResponse('y'));
    dom.btnPermissionAllowAll.addEventListener('click', () => sendPermissionResponse('a'));
    dom.btnPermissionDeny.addEventListener('click', () => sendPermissionResponse('n'));
    dom.btnPermissionSendCustom.addEventListener('click', sendCustomPermissionResponse);
    dom.permissionCustomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendCustomPermissionResponse();
      }
    });

    // History toggle
    dom.historyToggle.addEventListener('click', () => {
      const list = dom.historyList;
      const isCollapsed = list.classList.contains('collapsed');
      list.classList.toggle('collapsed', !isCollapsed);
      list.classList.toggle('expanded', isCollapsed);
      dom.historyToggle.classList.toggle('expanded', isCollapsed);
    });

    // Add custom agent
    dom.btnAddCustomAgent.addEventListener('click', () => {
      const name = dom.customAgentName.value.trim();
      const cmd = dom.customAgentCmd.value.trim();
      const flag = dom.customAgentFlag.value.trim();

      if (!name) {
        showToast('Please enter an agent name', 'warning');
        dom.customAgentName.focus();
        return;
      }
      if (!cmd) {
        showToast('Please enter a CLI command', 'warning');
        dom.customAgentCmd.focus();
        return;
      }

      // Check if command already exists
      const exists = state.agents.some((a) => a.command === cmd);
      if (exists) {
        showToast(`Agent with command "${cmd}" already exists`, 'warning');
        return;
      }

      // Generate a nice random color and default icon for the custom agent
      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      const newAgent = {
        name,
        command: cmd,
        argFlag: flag || undefined,
        icon: '⚙️',
        color: randomColor,
        description: `Custom agent using command "${cmd}"`,
        custom: true,
      };

      state.customAgents.push(newAgent);
      try {
        localStorage.setItem('agent-orchestrator-custom-agents', JSON.stringify(state.customAgents));
      } catch (e) {
        // ignore
      }

      // Clear inputs
      dom.customAgentName.value = '';
      dom.customAgentCmd.value = '';
      dom.customAgentFlag.value = '';

      showToast(`Added agent "${name}"`, 'success');

      // Re-detect agents
      detectAgents();
    });
  }

  // =========================================================================
  // Init
  // =========================================================================

  document.addEventListener('DOMContentLoaded', () => {
    // Load custom agents from local storage
    try {
      const saved = localStorage.getItem('agent-orchestrator-custom-agents');
      if (saved) {
        state.customAgents = JSON.parse(saved);
      }
    } catch (e) {
      // ignore
    }

    initTheme();
    wireEvents();
    connectWebSocket();
    detectAgents();
    loadHistory();
  });
})();
