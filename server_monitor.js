require('dotenv').config();
const { Redis } = require('@upstash/redis');
const express = require('express');
const client = require('prom-client');

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

const AGENTS = (process.env.AGENTS && process.env.AGENTS.split(',')) || ['codex','opencode','gemini','copilot'];
const POLL_INTERVAL = parseInt(process.env.MONITOR_POLL_INTERVAL || '15000', 10);
const PORT = parseInt(process.env.MONITOR_PORT || '9100', 10);

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const dlqGauge = new client.Gauge({ name: 'agent_dlq_size', help: 'Dead letter queue size per agent', labelNames: ['agent'] });
const queueGauge = new client.Gauge({ name: 'agent_queue_size', help: 'Pending queue size per agent', labelNames: ['agent'] });
const heartbeatAgeGauge = new client.Gauge({ name: 'agent_heartbeat_age_seconds', help: 'Seconds since last heartbeat per agent', labelNames: ['agent'] });
const dlqTotal = new client.Gauge({ name: 'agent_dlq_total', help: 'Total DLQ entries across agents' });
register.registerMetric(dlqGauge);
register.registerMetric(queueGauge);
register.registerMetric(heartbeatAgeGauge);
register.registerMetric(dlqTotal);

async function pollOnce() {
  try {
    let totalDlq = 0;
    for (const a of AGENTS) {
      try {
        const dlqKey = `deadletter:${a}`;
        const queueKey = `queue:${a}`;
        const dlqLen = (await redis.llen(dlqKey)) || 0;
        const queueLen = (await redis.llen(queueKey)) || 0;
        dlqGauge.set({ agent: a }, dlqLen);
        queueGauge.set({ agent: a }, queueLen);
        totalDlq += dlqLen;

        const hb = await redis.get(`heartbeat:${a}`);
        if (hb) {
          const age = Math.max(0, Math.floor((Date.now() - new Date(hb).getTime())/1000));
          heartbeatAgeGauge.set({ agent: a }, age);
        } else {
          heartbeatAgeGauge.set({ agent: a }, -1);
        }
      } catch (e) {
        console.error('Agent poll error', a, e.message || e);
      }
    }
    dlqTotal.set(totalDlq);
  } catch (e) {
    console.error('Monitor poll error', e.message || e);
  }
}

// Start periodic polling
setInterval(pollOnce, POLL_INTERVAL);
// Initial poll
pollOnce().catch(()=>{});

// HTTP server for /metrics and /health
const app = express();
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e) {
    res.status(500).end(e.message);
  }
});

app.get('/health', async (req, res) => {
  try {
    const info = {};
    for (const a of AGENTS) {
      const dlqLen = (await redis.llen(`deadletter:${a}`)) || 0;
      const queueLen = (await redis.llen(`queue:${a}`)) || 0;
      const hb = await redis.get(`heartbeat:${a}`);
      const hbAge = hb ? Math.max(0, Math.floor((Date.now() - new Date(hb).getTime())/1000)) : null;
      info[a] = { dlq: dlqLen, queue: queueLen, heartbeat_age_seconds: hbAge };
    }
    res.json({ status: 'ok', agents: info });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

app.listen(PORT, () => {
  console.log(`Monitor listening on http://0.0.0.0:${PORT} (metrics at /metrics)`);
});
