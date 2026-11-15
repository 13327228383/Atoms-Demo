'use strict';

/**
 * Atoms Demo —— 零依赖单进程服务。
 * 静态托管 + SSE 流式生成 + 真实模型状态探测。
 * 启动：node server.js   （默认 http://127.0.0.1:8787）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildMessages, extractHtml, streamCompletion, probeModels } = require('./lib/llm');
const store = require('./lib/store');
store.init();

// 轻量 .env 载入：只在进程内生效，不写入任何文件，键不会下发到前端。
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

const config = {
  provider: PROVIDER,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const full = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200000) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleGenerate(req, res) {
  let payload;
  try { payload = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  if (PROVIDER === 'cloud') {
    return sendJson(res, 400, {
      error: '当前为云端免密钥模式：模型由浏览器端 SDK 直接调用，服务端不代理（云服务禁止 BFF 转发）。请在页面内操作。'
    });
  }

  if (!payload.idea || !String(payload.idea).trim()) {
    return sendJson(res, 400, { error: '缺少 idea' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const emit = (obj) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const finish = () => { if (!res.writableEnded) res.end(); };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  req.on('close', () => controller.abort());

  emit({ type: 'status', message: `正在调用 ${PROVIDER === 'ollama' ? config.ollamaModel : config.openaiModel} 生成应用…` });

  let raw = '';
  try {
    const messages = buildMessages(payload);
    await streamCompletion({
      provider: PROVIDER,
      config,
      messages,
      signal: controller.signal,
      onDelta: (piece) => { raw += piece; emit({ type: 'delta', text: piece }); }
    });
  } catch (e) {
    emit({ type: 'error', message: e.name === 'AbortError' ? '生成超时或被中断（240s）' : e.message });
    clearTimeout(timer);
    return finish();
  }
  clearTimeout(timer);

  const html = extractHtml(raw);
  if (!html) {
    emit({ type: 'error', message: `模型返回了 ${raw.length} 字符，但未能从中提取出完整 HTML 文档。这是真实失败，不做补造；可重试或换更强的模型。` });
    return finish();
  }

  emit({
    type: 'done',
    html,
    rawLength: raw.length,
    provider: PROVIDER,
    model: PROVIDER === 'ollama' ? config.ollamaModel : config.openaiModel
  });
  finish();
}

async function handleConfig(res) {
  if (PROVIDER === 'cloud') {
    return sendJson(res, 200, {
      provider: 'cloud',
      model: '云端免密钥模型（浏览器端 SDK 自动选型）',
      modelOnline: true,
      availableModels: [],
      hasApiKey: false
    });
  }
  const probe = await probeModels(config, PROVIDER);
  sendJson(res, 200, {
    provider: PROVIDER,
    model: PROVIDER === 'ollama' ? config.ollamaModel : config.openaiModel,
    modelOnline: probe.online,
    availableModels: probe.models,
    hasApiKey: Boolean(config.openaiApiKey)
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    const modelLabel = PROVIDER === 'cloud'
      ? 'cloud-sdk (浏览器端免密钥模型)'
      : (PROVIDER === 'ollama' ? config.ollamaModel : config.openaiModel);
    return sendJson(res, 200, { status: 'ok', provider: PROVIDER, model: modelLabel, persistence: store.stats() });
  }
  if (req.method === 'GET' && p === '/api/config') return handleConfig(res);
  if (req.method === 'GET' && p === '/api/sessions') {
    return sendJson(res, 200, Object.assign(store.stats(), { items: store.listSessions(url.searchParams.get('limit') || 20) }));
  }
  if (req.method === 'POST' && p === '/api/sessions') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!body || !body.id) return sendJson(res, 400, { error: '缺少会话 id' });
    return sendJson(res, 200, store.saveSession(body));
  }
  if (req.method === 'POST' && p === '/api/generate') return handleGenerate(req, res);
  if (req.method === 'GET') return serveStatic(req, res, p);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log(`[Atoms Demo] http://127.0.0.1:${PORT}  provider=${PROVIDER}  model=${PROVIDER === 'ollama' ? config.ollamaModel : config.openaiModel}`);
});
