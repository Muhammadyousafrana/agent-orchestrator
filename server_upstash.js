require('dotenv').config();
const { Redis } = require('@upstash/redis');

function parseUpstashFromEnv() {
  // Support explicit vars or try to derive from REDIS_URL
  const explicitUrl = process.env.UPSTASH_URL || process.env.UPSTASH_REST_URL;
  const explicitToken = process.env.UPSTASH_TOKEN || process.env.UPSTASH_KEY;
  if (explicitUrl && explicitToken) return { url: explicitUrl, token: explicitToken };

  const raw = process.env.REDIS_URL || '';
  // expect formats like redis://default:TOKEN@host:port or rediss://default:TOKEN@host:port
  const m = raw.match(/redis(?:s)?:\/\/[^:]+:([^@]+)@([^:\/]+)(:\d+)?/);
  if (m) {
    const token = m[1];
    const host = m[2];
    // use HTTPS Upstash REST endpoint
    const url = `https://${host}`;
    return { url, token };
  }
  throw new Error('Upstash credentials not found in env (set UPSTASH_URL & UPSTASH_TOKEN or REDIS_URL)');
}

const creds = parseUpstashFromEnv();
const redis = new Redis({ url: creds.url, token: creds.token });

async function publishTask(agent, task) {
  task.retryCount = task.retryCount || 0;
  const key = `queue:${agent}`;
  await redis.rpush(key, JSON.stringify(task));
  console.log(`Queued task ${task.taskId} -> ${agent}`);
}

async function pushToDLQ(agent, task) {
  const dlqKey = `deadletter:${agent}`;
  await redis.rpush(dlqKey, JSON.stringify(task));
  await redis.rpush('progress', JSON.stringify({ taskId: task.taskId, agent, status: 'deadletter' })).catch(()=>{});
  console.log(`Pushed ${task.taskId} to DLQ ${dlqKey}`);
}

async function waitForResult(taskId, timeoutMs = 30000, intervalMs = 500) {
  const key = `result:${taskId}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await redis.get(key);
    if (raw) {
      try { return JSON.parse(raw); } catch(e) { return { raw }; }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('timeout');
}

async function runSampleWorkflow() {
  const roles = {
    planner: 'codex',
    implementer: 'opencode',
    reviewer: 'gemini',
    integrator: 'copilot'
  };

  try {
    const planTask = { taskId: `t-${Date.now()}-plan`, role: 'planner', action: 'analyze', details: { goal: 'Implement feature X' } };
    await publishTask(roles.planner, planTask);
    const planResult = await waitForResult(planTask.taskId, 30000);
    console.log('Plan result:', planResult);

    const implTask = { taskId: `t-${Date.now()}-impl`, role: 'implementer', action: 'implement', details: { plan: planResult.output } };
    await publishTask(roles.implementer, implTask);
    const implResult = await waitForResult(implTask.taskId, 60000);
    console.log('Implementation result:', implResult);

    const reviewTask = { taskId: `t-${Date.now()}-review`, role: 'reviewer', action: 'review', details: { artifact: implResult.output } };
    await publishTask(roles.reviewer, reviewTask);
    const reviewResult = await waitForResult(reviewTask.taskId, 30000);
    console.log('Review result:', reviewResult);

    const intTask = { taskId: `t-${Date.now()}-int`, role: 'integrator', action: 'integrate', details: { reviewed: reviewResult.output } };
    await publishTask(roles.integrator, intTask);
    const intResult = await waitForResult(intTask.taskId, 30000);
    console.log('Integration result:', intResult);

    console.log('Sample workflow complete.');
    process.exit(0);
  } catch (err) {
    console.error('Workflow error:', err.message || err);
    process.exit(1);
  }
}

// Lightweight progress logging: tail recent progress entries
async function tailProgressLoop() {
  while(true) {
    try {
      const raw = await redis.lpop('progress');
      if (raw) console.log('[progress]', JSON.parse(raw));
      else await new Promise(r=>setTimeout(r, 500));
    } catch(e) { console.error('Progress tail error', e); await new Promise(r=>setTimeout(r, 1000)); }
  }
}

// Start sample workflow after brief delay to let agents start polling
setTimeout(()=>{ runSampleWorkflow(); }, 1500);
// Start progress tail in background
tailProgressLoop().catch(()=>{});
