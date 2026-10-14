require('dotenv').config();
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

function publishTask(agent, task) {
  const channel = `agent:${agent}:tasks`;
  redis.publish(channel, JSON.stringify(task));
  console.log(`Published task ${task.taskId} -> ${agent}`);
}

function waitForResult(taskId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const onMessage = (channel, message) => {
      try {
        const obj = JSON.parse(message);
        if (obj.taskId === taskId) {
          redis.removeListener('message', onMessage);
          resolve(obj);
        }
      } catch (e) {}
    };
    redis.subscribe('results').then(()=>redis.on('message', onMessage));
    setTimeout(()=>{
      redis.removeListener('message', onMessage);
      reject(new Error('timeout'));
    }, timeoutMs);
  });
}

async function runSampleWorkflow() {
  const roles = {
    planner: 'codex',
    implementer: 'opencode',
    reviewer: 'gemini',
    integrator: 'copilot'
  };

  try {
    // 1) Planning
    const planTask = { taskId: `t-${Date.now()}-plan`, role: 'planner', action: 'analyze', details: { goal: 'Implement feature X' } };
    publishTask(roles.planner, planTask);
    const planResult = await waitForResult(planTask.taskId);
    console.log('Plan result:', planResult);

    // 2) Implementation
    const implTask = { taskId: `t-${Date.now()}-impl`, role: 'implementer', action: 'implement', details: { plan: planResult.output } };
    publishTask(roles.implementer, implTask);
    const implResult = await waitForResult(implTask.taskId, 60000);
    console.log('Implementation result:', implResult);

    // 3) Review
    const reviewTask = { taskId: `t-${Date.now()}-review`, role: 'reviewer', action: 'review', details: { artifact: implResult.output } };
    publishTask(roles.reviewer, reviewTask);
    const reviewResult = await waitForResult(reviewTask.taskId);
    console.log('Review result:', reviewResult);

    // 4) Integration
    const intTask = { taskId: `t-${Date.now()}-int`, role: 'integrator', action: 'integrate', details: { reviewed: reviewResult.output } };
    publishTask(roles.integrator, intTask);
    const intResult = await waitForResult(intTask.taskId);
    console.log('Integration result:', intResult);

    console.log('Sample workflow complete.');
    process.exit(0);
  } catch (err) {
    console.error('Workflow error:', err.message || err);
    process.exit(1);
  }
}

// Log progress and results
redis.subscribe('progress','results').then(()=>{
  redis.on('message', (channel, message) => {
    try {
      const obj = JSON.parse(message);
      console.log(`[${channel}]`, obj);
    } catch(e) { console.log(`[${channel}]`, message); }
  });
});

// Start sample workflow after brief delay to let agents subscribe
setTimeout(runSampleWorkflow, 1500);
