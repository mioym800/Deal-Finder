// routes/automationService.js (or inside your existing automation routes file)
import { Router } from 'express';
import { execFile, spawn } from 'node:child_process';
import util from 'node:util';

// runtime: 'docker' | 'node' (local Node process)
const RUNTIME = (process.env.AUTOMATION_RUNTIME || 'docker').toLowerCase();
const CONTAINER = process.env.AUTOMATION_CONTAINER || 'deal-finder-automation';

// Node worker launch configuration (used when RUNTIME==='node')
const NODE_CMD = process.env.AUTOMATION_NODE_CMD || 'node';
const NODE_ARGS = (process.env.AUTOMATION_NODE_ARGS && JSON.parse(process.env.AUTOMATION_NODE_ARGS))
  || ['vendors/runAutomation.js', '--worker'];
const NODE_CWD = process.env.AUTOMATION_NODE_CWD || process.cwd();

const router = Router();
const execFileAsync = util.promisify(execFile);
const sh = (cmd, args) => execFileAsync(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, error, code = 500) => res.status(code).json({ ok: false, error: String(error) });

// Singleton child process handle for local Node runtime
let nodeChild = null;

function requireAdmin(req, res, next) {
  try {
    // e.g., req.user.role === 'admin'
    return next();
  } catch {
    return fail(res, 'Unauthorized', 401);
  }
}

router.get('/status', async (_req, res) => {
  try {
    if (RUNTIME === 'docker') {
      const { stdout: inspect } = await sh('docker', ['inspect', CONTAINER, '--format', '{{json .State}}']);
      const state = JSON.parse((inspect || '{}').trim() || '{}');
      return ok(res, {
        runtime: 'docker',
        status: state?.Status || 'unknown',
        meta: state || {},
      });
    } else if (RUNTIME === 'node') {
      const running = !!(nodeChild && !nodeChild.killed);
      return ok(res, {
        runtime: 'node',
        status: running ? 'running' : 'exited',
        meta: {
          pid: running ? nodeChild.pid : null,
          started: running ? nodeChild.__startedAt : null,
        },
      });
    } else {
      return fail(res, `Unsupported AUTOMATION_RUNTIME: ${RUNTIME}`, 400);
    }
  } catch (e) {
    return fail(res, e.stderr || e.message);
  }
});

router.post('/start', async (_req, res) => {
  try {
    if (RUNTIME === 'docker') {
      await sh('docker', ['start', CONTAINER]);
      return ok(res, { status: 'starting' });
    } else if (RUNTIME === 'node') {
      if (nodeChild && !nodeChild.killed) {
        return ok(res, { status: 'already-running', pid: nodeChild.pid });
      }
      // Spawn local worker
      nodeChild = spawn(NODE_CMD, NODE_ARGS, {
        cwd: NODE_CWD,
        env: { ...process.env, AUTOMATION_WORKER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      nodeChild.__startedAt = new Date().toISOString();
      nodeChild.on('exit', () => { /* let /status reflect it */ });
      return ok(res, { status: 'starting', pid: nodeChild.pid });
    } else {
      return fail(res, `Unsupported AUTOMATION_RUNTIME: ${RUNTIME}`, 400);
    }
  } catch (e) {
    return fail(res, e.stderr || e.message);
  }
});

router.post('/stop', async (_req, res) => {
  try {
    if (RUNTIME === 'docker') {
      await sh('docker', ['stop', CONTAINER]);
      return ok(res, { status: 'stopping' });
    } else if (RUNTIME === 'node') {
      if (!nodeChild || nodeChild.killed) {
        return ok(res, { status: 'not-running' });
      }
      nodeChild.kill('SIGTERM');
      // best-effort wait; don't block response
      return ok(res, { status: 'stopping', pid: nodeChild.pid });
    } else {
      return fail(res, `Unsupported AUTOMATION_RUNTIME: ${RUNTIME}`, 400);
    }
  } catch (e) {
    return fail(res, e.stderr || e.message);
  }
});

router.post('/restart', async (_req, res) => {
  try {
    if (RUNTIME === 'docker') {
      await sh('docker', ['restart', CONTAINER]);
      return ok(res, { status: 'restarting' });
    } else if (RUNTIME === 'node') {
      if (nodeChild && !nodeChild.killed) nodeChild.kill('SIGTERM');
      // small async delay before start
      setTimeout(() => {
        nodeChild = spawn(NODE_CMD, NODE_ARGS, {
          cwd: NODE_CWD,
          env: { ...process.env, AUTOMATION_WORKER: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
        nodeChild.__startedAt = new Date().toISOString();
      }, 250);
      return ok(res, { status: 'restarting' });
    } else {
      return fail(res, `Unsupported AUTOMATION_RUNTIME: ${RUNTIME}`, 400);
    }
  } catch (e) {
    return fail(res, e.stderr || e.message);
  }
});

// (Optional) live logs via SSE (docker logs or node child stdout/stderr)
router.get('/logs/stream', async (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  let child;
  try {
    if (RUNTIME === 'docker') {
      child = execFile('docker', ['logs', '-f', '--since', '1m', CONTAINER]);
    } else if (RUNTIME === 'node') {
      if (!nodeChild || nodeChild.killed) {
        send('log', { line: '[logs] local worker not running' });
        return; // keep SSE open; client may retry later
      }
      // stream stdout/stderr from the child
      nodeChild.stdout.on('data', chunk => send('log', { line: String(chunk) }));
      nodeChild.stderr.on('data', chunk => send('error', { line: String(chunk) }));
      nodeChild.on('close', code => send('end', { code }));
      // do not end the response here; SSE stays open until client closes
      _req.on('close', () => { /* nothing to kill here */ });
      return;
    } else {
      send('error', { line: `Unsupported runtime: ${RUNTIME}` });
      return res.end();
    }
  } catch (e) {
    send('error', { line: e.message || String(e) });
    return res.end();
  }

  // docker path: wire child process
  child.stdout.on('data', chunk => send('log', { line: String(chunk) }));
  child.stderr.on('data', chunk => send('error', { line: String(chunk) }));
  child.on('close', code => send('end', { code }));
  _req.on('close', () => { try { child.kill(); } catch {} });
});

// Unified logs stream for Control Panel
router.get('/logs', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  let child;
  try {
    if (RUNTIME === 'docker') {
      child = execFile('docker', ['logs', '-f', '--since', '1m', CONTAINER]);
    } else if (RUNTIME === 'node') {
      if (!nodeChild || nodeChild.killed) {
        send('log', { line: '[logs] local worker not running' });
        return; // leave SSE open
      }
      nodeChild.stdout.on('data', chunk => send('log', { line: String(chunk) }));
      nodeChild.stderr.on('data', chunk => send('error', { line: String(chunk) }));
      nodeChild.on('close', code => send('end', { code }));
      req.on('close', () => { /* nothing */ });
      return;
    } else {
      send('error', { line: `Unsupported runtime: ${RUNTIME}` });
      return res.end();
    }
  } catch (e) {
    send('error', { line: e.message || String(e) });
    return res.end();
  }

  child.stdout.on('data', chunk => send('log', { line: String(chunk) }));
  child.stderr.on('data', chunk => send('error', { line: String(chunk) }));
  child.on('close', code => send('end', { code }));
  req.on('close', () => { try { child.kill(); } catch {} });
});

const automationServiceRoutes = router
export default automationServiceRoutes;