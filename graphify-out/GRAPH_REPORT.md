# Graph Report - agent-orchestrator  (2026-06-04)

## Corpus Check
- 15 files · ~9,237 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 144 nodes · 178 edges · 15 communities (13 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]

## God Nodes (most connected - your core abstractions)
1. `Workflow` - 12 edges
2. `handleWsMessage()` - 7 edges
3. `launchWorkflow()` - 7 edges
4. `Orchestrator` - 6 edges
5. `ProcessRunner` - 6 edges
6. `$()` - 6 edges
7. `showToast()` - 6 edges
8. `resetToSetup()` - 5 edges
9. `detectAgents()` - 4 edges
10. `goToStep()` - 4 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities (15 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (28): $(), appendOutput(), detectAgents(), dom, escapeHtml(), goToStep(), handleWsMessage(), launchWorkflow() (+20 more)

### Community 1 - "Community 1"
Cohesion: 0.1
Nodes (17): app, clients, customAgents, { detectAgents }, express, fs, http, { Orchestrator } (+9 more)

### Community 2 - "Community 2"
Cohesion: 0.12
Nodes (11): CLI_PATTERNS, crypto, { EventEmitter }, fs, path, PHASE_ORDER, { ProcessRunner }, ROLES (+3 more)

### Community 3 - "Community 3"
Cohesion: 0.12
Nodes (13): app, client, creds, dlqGauge, dlqTotal, express, heartbeatAgeGauge, info (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.22
Nodes (9): creds, { exec }, { hideBin }, parseFlexible(), pollLoop(), processTask(), publishProgress(), { Redis } (+1 more)

### Community 6 - "Community 6"
Cohesion: 0.28
Nodes (5): creds, publishTask(), { Redis }, runSampleWorkflow(), waitForResult()

### Community 7 - "Community 7"
Cohesion: 0.33
Nodes (6): { exec }, { hideBin }, publish(), Redis, start(), yargs

### Community 8 - "Community 8"
Cohesion: 0.47
Nodes (5): obj, publishTask(), Redis, runSampleWorkflow(), waitForResult()

## Knowledge Gaps
- **58 isolated node(s):** `{ Redis }`, `{ exec }`, `yargs`, `{ hideBin }`, `creds` (+53 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Workflow` connect `Community 4` to `Community 2`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `Orchestrator` connect `Community 9` to `Community 1`, `Community 2`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `{ Redis }`, `{ exec }`, `yargs` to the rest of the system?**
  _58 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._