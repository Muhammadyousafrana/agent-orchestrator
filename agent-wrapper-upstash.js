#!/usr/bin/env node
require('dotenv').config();
const { Redis } = require('@upstash/redis');
const { exec } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('agent', { type: 'string', demandOption: true })
  .option('cmd', { type: 'string', description: 'Command template; supports {{taskId}} and {{repo}}' })
  .argv;

function parseUpstashFromEnv() {
  const explicitUrl = process.env.UPSTASH_URL || process.env.UPSTASH_REST_URL;
  const explicitToken = process.env.UPSTASH_TOKEN || process.env.UPSTASH_KEY;
  if (explicitUrl && explicitToken) return { url: explicitUrl, token: explicitToken };
  const raw = process.env.REDIS_URL || '';
  const m = raw.match(/redis(?:s)?:\/\/[^:]+:([^@]+)@([^:\/]+)(:\d+)?/);
  if (m) {
    const token = m[1];
    const host = m[2];
    const url = `https://${host}`;
    return { url, token };
  }
  throw new Error('Upstash credentials not found in env (set UPSTASH_URL & UPSTASH_TOKEN or REDIS_URL)');
}

const creds = parseUpstashFromEnv();
const redis = new Redis({ url: creds.url, token: creds.token });
const agent = argv.agent;
const cmdTemplate = argv.cmd || '';

function publishProgress(obj) { return redis.rpush('progress', JSON.stringify(obj)); }

// Parse task payloads flexibly: try JSON.parse, then tolerant single-quote fallback
function parseFlexible(raw) {
  if (!raw && raw !== 0) return null;
  if (typeof raw === 'object' && raw !== null) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) {
      // try to tolerate single-quoted JS object notation
      try {
        const s = raw.replace(/(["'])?(\w+)\1?\s*:/g, '"$2":').replace(/'/g, '"');
        return JSON.parse(s);
      } catch (e2) {
        return null;
      }
    }
  }
  try { return JSON.parse(String(raw)); } catch (e) { return null; }
}

async function processTask(task) {
  publishProgress({ taskId: task.taskId, agent, status: 'started' }).catch(()=>{});
  if (cmdTemplate) {
    const cmd = cmdTemplate.replace(/{{taskId}}/g, task.taskId).replace(/{{repo}}/g, (task.details && task.details.repo) || '');
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '') + (err ? `\nERROR: ${err.message}` : '');
        redis.set(`result:${task.taskId}`, JSON.stringify({ taskId: task.taskId, agent, output, success: !err }), { ex: 3600 })
          .then(()=> publishProgress({ taskId: task.taskId, agent, status: err ? 'failed' : 'done' }))
          .then(()=> { if (err) reject(err); else resolve(); })
          .catch((e)=> { console.error('Failed to save result', e); if (err) reject(err); else resolve(); });
      });
    });
  } else {
    // simulate work
    const delay = 1000 + Math.floor(Math.random()*3000);
    await new Promise(r => setTimeout(r, delay));
    const output = `${agent} simulated result for ${task.taskId} (action=${task.action})`;
    await redis.set(`result:${task.taskId}`, JSON.stringify({ taskId: task.taskId, agent, output, success: true }), { ex: 3600 });
    await publishProgress({ taskId: task.taskId, agent, status: 'done' });
  }
}

async function pollLoop() {
  const queueKey = `queue:${agent}`;
  const maxRetries = parseInt(process.env.AGENT_MAX_RETRIES || '3', 10);
  const batchSize = parseInt(process.env.AGENT_BATCH_SIZE || '5', 10);
  let backoffMs = 800;
  const maxBackoffMs = 5000;

  // heartbeat
  setInterval(()=> {
    redis.set(`heartbeat:${agent}`, new Date().toISOString(), { ex: 15 }).catch(()=>{});
  }, 5000);

  async function processTaskWithRetries(task) {
    try {
      console.log(`${agent} processing ${task.taskId}`);
      await processTask(task);
    } catch (err) {
      console.error('Task processing failed', task.taskId, err);
      task.retryCount = (task.retryCount || 0) + 1;
      if (task.retryCount <= maxRetries) {
        // brief backoff before requeue
        await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random()*1000)));
        await redis.rpush(queueKey, JSON.stringify(task));
        await publishProgress({ taskId: task.taskId, agent, status: 'requeued', retryCount: task.retryCount }).catch(()=>{});
      } else {
        const dlqKey = `deadletter:${agent}`;
        await redis.rpush(dlqKey, JSON.stringify(task));
        await publishProgress({ taskId: task.taskId, agent, status: 'deadletter', retryCount: task.retryCount }).catch(()=>{});
        console.log(`Task ${task.taskId} moved to DLQ ${dlqKey}`);
      }
    }
  }

  while(true) {
    try {
      // try to fetch a batch: pop first item then attempt to pop more without waiting
      const raw = await redis.lpop(queueKey);
      if (!raw) {
        // no task: backoff with jitter
        const jitter = Math.floor(Math.random()*300);
        await new Promise(r => setTimeout(r, backoffMs + jitter));
        backoffMs = Math.min(maxBackoffMs, Math.floor(backoffMs * 1.5));
        continue;
      }
      // reset backoff when a task arrives
      backoffMs = 800;

      const tasks = [];
      // parse first
      const firstTask = parseFlexible(raw);
      if (!firstTask) { console.error('Invalid task JSON (could not parse)', raw); continue; }
      if (!firstTask.taskId) { console.error('Invalid task object (missing taskId)', firstTask); continue; }
      tasks.push(firstTask);

      // quick poll for additional items up to batchSize
      for (let i=1;i<batchSize;i++) {
        const more = await redis.lpop(queueKey);
        if (!more) break;
        // parse additional task
        const t = parseFlexible(more);
        if (!t) { console.error('Invalid task JSON (could not parse)', more); continue; }
        if (!t || !t.taskId) { console.error('Invalid task (missing id)', t); continue; }
        tasks.push(t);
      }

      // process tasks sequentially (avoid parallel overload); can be adjusted
      for (const task of tasks) {
        await processTaskWithRetries(task);
      }

    } catch (e) {
      console.error('Poll error', e);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

console.log(`${agent} polling ${'queue:' + agent}`);
pollLoop().catch(e=>{ console.error('Fatal', e); process.exit(1); });
