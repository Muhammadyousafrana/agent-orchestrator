Agent Orchestrator

Overview
- Local web UI for running installed AI agent CLIs against a project folder.
- Detects known CLIs on PATH, lets you add custom CLIs, assigns each selected agent a role, and runs a role-based workflow.
- A selected Parent Orchestrator can act as the parent agent: it plans first, delegates child-agent tasks, reviews child handoffs after phases, and finalizes the workflow.
- Child agents communicate back through streamed output plus a shared `.agent_context.md` file written inside the target project while the workflow is running.
- Agents can send explicit messages to the parent or each other with `MESSAGE TO [recipient]: message`; those messages are captured into each agent's inbox in `.agent_context.md`.
- If a CLI asks for approval, the browser shows a permission dialog and forwards the user's response to the agent process.

Quick Start
1. Install Node.js 18+.
2. Run `npm install`.
3. Start the UI with `npm start`.
4. Open `http://localhost:3000`.
5. Select installed agents, assign roles, enter a project path and task, then launch the workflow.

Workflow
- `orchestrator` runs the parent phase, delegates work, reviews child handoffs, and finalizes.
- `architect` runs the design phase and creates the plan.
- `builder` implements the requested changes.
- `tester` validates the changed behavior.
- `reviewer` checks quality, safety, and regressions.
- `integrator` combines prior handoffs into a final result.

Parent/Child Execution
- With more than one selected agent, the first selected agent defaults to `Parent Orchestrator`.
- Sequential mode runs: parent plan, child phase, parent review, next child phase, parent finalization.
- Parallel mode runs: parent plan, child phases in parallel, parent finalization.
- The parent must use selected CLI agents as child agents before creating any internal subagent.
- The parent does not start selected child CLI processes itself; the Node orchestrator service launches them after the parent checkpoint exits.
- Parent output that says a selected child is "running in the background" is treated as misleading unless that child has already produced workflow output.
- The parent assigns work by exact selected role or phase first, then by closest selected role as a fallback.
- The parent may create its own internal subagent only after deciding no selected child CLI can reasonably own the task.
- Child prompts tell agents to use their own sub-agent or delegation features when their CLI supports it.
- Child agents may add task-specific tools, skills, MCP servers, plugins, or dependencies when needed.
- If a child agent creates internal subagents, it should report their work with `SUBAGENT START/OUTPUT/DONE/ERROR [name]: message` so the UI can display it.
- Installs, network access, system changes, or writes outside the project should go through the browser permission prompt.
- Failed child phases fail the workflow and emit an explicit stderr line in the agent terminal.

Agent Communication
- The parent can message selected children by exact agent name, role, `children`, or `all`.
- Child agents can message `Parent Orchestrator`, exact sibling agent names, `role:<role-key>`, or `all`.
- Before each CLI starts, `.agent_context.md` is regenerated with that agent's inbox and the recent team message log.
- Message lines are also shown live in the workflow terminal output.

Internal Subagent Reporting
- `SUBAGENT START [name]: objective` marks an internal subagent starting.
- `SUBAGENT OUTPUT [name]: progress or finding` shows ongoing work.
- `SUBAGENT DONE [name]: result` marks completed work.
- `SUBAGENT ERROR [name]: blocker or failure` marks failed work.
- These events appear live under the selected CLI agent that created the internal subagent.

Agent CLI Notes
- Built-in command patterns are defined in `lib/orchestrator.js`.
- Known CLIs include Gemini, GitHub Copilot, OpenCode, Codex, Claude Code, and Aider.
- Custom agents can be added from the UI with an optional prompt flag such as `-p`.
- The runner keeps stdin open so interactive approval prompts can be answered from the UI.
- Agent processes use a 60-minute hard max timeout and a 15-minute idle timeout by default.
- Set `AGENT_TIMEOUT_MS` and `AGENT_IDLE_TIMEOUT_MS` in `.env` to adjust those limits for long-running tasks.

Permission Prompts
- When agent output looks like an approval request, the UI opens an "Agent Needs Permission" dialog.
- `Allow Once` sends `y`.
- `Allow All` sends `a`.
- `Deny` sends `n`.
- `Send Custom` forwards any exact text required by a specific CLI.

Legacy Redis Sample
- `server.js`, `agent-wrapper.js`, and `start-agents.ps1` are the older Redis pub/sub sample path.
- The primary local-agent workflow is the `npm start` web app.
