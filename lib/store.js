'use strict';

/**
 * 真实数据持久化层：优先 SQLite（Node 内置 node:sqlite，零 npm 依赖），
 * 运行时不支持时降级为 JSON 文件，再不行才退回内存并如实标注 persistent=false。
 * 存的是会话与生成记录（元数据 + 版本摘要），不含 HTML 源码全文 —— 完整源码由浏览器
 * localStorage 持久化，避免请求体里出现 HTML 标签字面量触发线上 WAF 的 XSS 规则。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'atoms.db');
const JSON_PATH = path.join(DATA_DIR, 'sessions.json');

let engine = 'none';
let db = null;
let memory = [];

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); return true; } catch { return false; }
}

function init() {
  if (!ensureDir()) { engine = 'memory'; return info(); }
  try {
    const sqlite = require('node:sqlite');
    db = new sqlite.DatabaseSync(DB_PATH);
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER, payload TEXT)');
    engine = 'sqlite';
  } catch (e) {
    db = null;
    try {
      if (!fs.existsSync(JSON_PATH)) fs.writeFileSync(JSON_PATH, '[]', 'utf8');
      JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      engine = 'json-file';
    } catch { engine = 'memory'; }
  }
  return info();
}

function info() {
  return {
    engine,
    persistent: engine !== 'memory' && engine !== 'none',
    path: engine === 'sqlite' ? 'data/atoms.db' : (engine === 'json-file' ? 'data/sessions.json' : null)
  };
}

function saveSession(payload) {
  const id = String(payload && payload.id ? payload.id : ('s' + Date.now()));
  const now = Date.now();
  const text = JSON.stringify(payload || {});
  if (engine === 'sqlite') {
    db.prepare('INSERT INTO sessions(id, created_at, updated_at, payload) VALUES(?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload')
      .run(id, now, now, text);
  } else if (engine === 'json-file') {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8') || '[]'); } catch { list = []; }
    const i = list.findIndex((x) => x && x.id === id);
    const rec = { id, updated_at: now, payload };
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    fs.writeFileSync(JSON_PATH, JSON.stringify(list.slice(0, 50)), 'utf8');
  } else {
    const i = memory.findIndex((x) => x.id === id);
    const rec = { id, updated_at: now, payload };
    if (i >= 0) memory[i] = rec; else memory.unshift(rec);
    memory = memory.slice(0, 50);
  }
  return { id, engine, persistent: info().persistent };
}

function listSessions(limit) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  let rows = [];
  if (engine === 'sqlite') {
    rows = db.prepare('SELECT id, created_at, updated_at, payload FROM sessions ORDER BY updated_at DESC LIMIT ?').all(n);
  } else if (engine === 'json-file') {
    try { rows = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8') || '[]').slice(0, n); } catch { rows = []; }
  } else {
    rows = memory.slice(0, n);
  }
  return rows.map((r) => {
    let payload = r.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
    return { id: r.id, updated_at: r.updated_at, payload };
  });
}

function stats() {
  let count = 0;
  if (engine === 'sqlite') {
    try { count = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c; } catch { count = 0; }
  } else if (engine === 'json-file') {
    try { count = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8') || '[]').length; } catch { count = 0; }
  } else { count = memory.length; }
  return Object.assign(info(), { sessions: count });
}

module.exports = { init, info, saveSession, listSessions, stats };
