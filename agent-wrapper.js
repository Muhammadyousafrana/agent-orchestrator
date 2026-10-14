#!/usr/bin/env node
require('dotenv').config();
const Redis = require('ioredis');
const { exec } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('agent', { type: 'string', demandOption: true })
  .option('cmd', { type: 'string', description: 'Command template to execute; supports {{taskId}} and {{repo}} placeholders' })
  .argv;

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const agent = argv.agent;
const cmdTemplate = argv.cmd || '';

function publish(channel, obj) { redis.publish(channel, JSON.stringify(obj)); }

async function start() {
  const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const channel = `agent:${agent}:tasks`;
  await sub.subscribe(channel);
  console.log(`${agent} subscribed to ${channel}`);
  publish('progress', { agent, status: 'ready' });

  sub.on('message', async (ch, message) => {
    try {
      const task = JSON.parse(message);
      console.log(`${agent} received task`, task.taskId, task.action);
      publish('progress', { taskId: task.taskId, agent, status: 'started' });

      if (cmdTemplate) {
        const cmd = cmdTemplate.replace(/{{taskId}}/g, task.taskId).replace(/{{repo}}/g, (task.details && task.details.repo) || '');
        exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
          const output = (stdout || stderr || '') + (err ? `\nERROR: ${err.message}` : '');
          publish('results', { taskId: task.taskId, agent, output, success: !err });
          publish('progress', { taskId: task.taskId, agent, status: 'done' });
        });
      } else {
        // Simulate processing
        const delay = 1000 + Math.floor(Math.random()*3000);
        setTimeout(()=>{
          const output = `${agent} simulated result for ${task.taskId} (action=${task.action})`;
          publish('results', { taskId: task.taskId, agent, output, success: true });
          publish('progress', { taskId: task.taskId, agent, status: 'done' });
        }, delay);
      }
    } catch (e) { console.error('Failed to handle message', e); }
  });
}

start().catch(e=>{ console.error(e); process.exit(1); });
