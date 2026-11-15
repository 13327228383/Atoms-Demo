'use strict';

/**
 * 零依赖真实浏览器 E2E：通过 Chrome DevTools Protocol 驱动本机 Chromium。
 * 全程模拟真实用户操作（聚焦输入框 → 键盘输入 → 鼠标点击），不直调后端生成接口。
 * 证据：tests/results/e2e_result.json + preview.png / selfcheck.png / iteration.png
 *
 * 运行：node tests/e2e_cdp.js        （默认检查 127.0.0.1:8787 的服务与 9223 的 CDP）
 * 可选：BASE=http://... CDP_PORT=9223 GENERATE_TIMEOUT_MS=420000
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'tests', 'results');
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const CHROME = process.env.CHROME_PATH || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const TIMEOUT = Number(process.env.GENERATE_TIMEOUT_MS || 420000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBrowser() {
  const url = `http://127.0.0.1:${CDP_PORT}/json/version`;
  try { await fetch(url); return { started: false, version: (await (await fetch(url)).json()).Browser }; } catch {}
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(ROOT, 'tests', '.cdp-profile')}`,
    'about:blank'
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const v = await (await fetch(url)).json(); return { started: true, version: v.Browser }; } catch {}
  }
  throw new Error('Chromium CDP 端口未能就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.events.push(m);
    };
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('WebSocket 连接失败'));
      setTimeout(() => rej(new Error('WebSocket 连接超时')), 10000);
    });
    return new CDP(ws);
  }
  send(method, params) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : null;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function realType(cdp, selector, text) {
  await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp.send('Input.insertText', { text });
  const typed = await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
  if (typed !== text) throw new Error(`输入未生效: 期望 ${text.length} 字符，实际 ${(typed || '').length}`);
}

async function realClick(cdp, selector) {
  const box = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
  if (!box) throw new Error('找不到可点击元素: ' + selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
}

async function waitFor(cdp, expression, timeoutMs, label, onTick) {
  const start = Date.now();
  for (;;) {
    const v = await cdp.eval(expression);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时: ' + label);
    if (onTick) await onTick(Math.round((Date.now() - start) / 1000));
    await sleep(1500);
  }
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (r.result && r.result.data) {
    fs.writeFileSync(path.join(RESULTS, name), Buffer.from(r.result.data, 'base64'));
    return name;
  }
  return null;
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const result = {
    mode: 'real-browser-cdp-ui-flow', base: BASE,
    timestamp: new Date().toISOString(), steps: [], screenshots: []
  };
  let cdp, targetId;
  try {
    const browser = await ensureBrowser();
    result.browser = browser;
    result.steps.push({ step: '启动/复用真实 Chromium', ok: true, version: browser.version });

    const health = await (await fetch(BASE + '/health')).json();
    result.steps.push({ step: '服务健康检查', ok: health.status === 'ok', response: health });

    const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
    targetId = t.id;
    cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // 等模型状态探测真正返回，避免把"检测模型中…"这个中间态误判成失败
    await waitFor(cdp,
      'document.readyState === "complete" && /在线|离线|配置读取失败/.test(document.querySelector("#modelBadge").textContent)',
      30000, '首页与模型状态就绪');
    const badge = await cdp.eval('document.querySelector("#modelBadge").textContent');
    result.steps.push({ step: '前端页面与模型状态', ok: /在线/.test(badge), text: badge });

    const idea = '做个待办清单，能添加任务、勾选完成、删除任务';
    await realType(cdp, '#idea', idea);
    await realClick(cdp, '#sendBtn');
    result.steps.push({ step: '真实键盘输入 + 鼠标点击发起生成', ok: true, idea });

    let lastTick = 0;
    const verdict = await waitFor(cdp,
      `(() => { const e = document.querySelector('#checkView .verdict'); return e ? e.textContent.trim() : false; })()`,
      TIMEOUT, '模型生成与自动自检',
      async (sec) => {
        if (sec - lastTick >= 10) {
          lastTick = sec;
          const s = await cdp.eval(`(() => { const m = document.querySelector('.msg.stream'); const msgs = document.querySelectorAll('#messages .msg'); return {stream: m ? m.textContent.slice(0,60) : '', msgs: msgs.length, btn: document.querySelector('#sendBtn').textContent}; })()`);
          result.steps.push({ step: `生成中 ${sec}s`, ok: true, ...s });
        }
      });
    result.steps.push({ step: '自动冒烟自检出报告', ok: Boolean(verdict), verdict });

    const report = await cdp.eval(`(() => ({
      checks: Array.from(document.querySelectorAll('#panel-check .check-item')).map(e => ({status: e.className.split(' ').pop(), title: e.querySelector('.title').textContent, detail: e.querySelector('.detail').textContent})),
      meta: (document.querySelector('.check-meta')||{}).textContent || '',
      dot: document.querySelector('#checkDot').className
    }))()`);
    result.selfcheck = report;
    result.steps.push({ step: '自检检查项数量', ok: report.checks.length >= 4, count: report.checks.length, titles: report.checks.map((c) => c.title) });

    const preview = await cdp.eval(`(() => { const f = document.querySelector('#preview'); return { srcdocLength: (f.srcdoc||'').length, hasHtml: /<html/i.test(f.srcdoc||''), visible: !document.querySelector('#previewWrap').classList.contains('hidden') }; })()`);
    result.preview = preview;
    result.steps.push({ step: '预览 iframe 注入生成的应用', ok: preview.hasHtml && preview.visible && preview.srcdocLength > 200, ...preview });

    await cdp.eval('document.querySelector(\'.tab[data-tab="code"]\').click()');
    const code = await cdp.eval(`(() => { const c = document.querySelector('#codeView').textContent; return {length: c.length, hasHtml: /<html/i.test(c) && /<\\/html>/i.test(c), downloadEnabled: !document.querySelector('#downloadBtn').disabled}; })()`);
    result.code = code;
    result.steps.push({ step: '代码页与导出控件', ok: code.hasHtml && code.downloadEnabled, ...code });

    await cdp.eval('document.querySelector(\'.tab[data-tab="preview"]\').click()');
    await sleep(600);
    result.screenshots.push(await shot(cdp, 'preview.png'));
    await cdp.eval('document.querySelector(\'.tab[data-tab="check"]\').click()');
    await sleep(300);
    result.screenshots.push(await shot(cdp, 'selfcheck.png'));

    const idea2 = '把标题改成「我的待办」，并加上未完成任务计数';
    await realType(cdp, '#idea', idea2);
    await realClick(cdp, '#sendBtn');
    const versions = await waitFor(cdp,
      `(() => { const o = document.querySelectorAll('#versionSelect option'); return o.length >= 2 ? Array.from(o).map(x=>x.textContent) : false; })()`,
      TIMEOUT, '多轮对话产生新版本');
    result.iteration = { idea: idea2, versions };
    result.steps.push({ step: '多轮对话修改产生新版本', ok: versions.length >= 2, versions });

    // 等第二版也跑完自动自检，避免证据停在"自检中"
    const verdict2 = await waitFor(cdp,
      `(() => { const e = document.querySelector('#checkView .verdict'); return e ? e.textContent.trim() : false; })()`,
      TIMEOUT, 'v2 自动冒烟自检');
    result.iteration.verdict = verdict2;
    result.steps.push({ step: 'v2 自动自检出报告', ok: Boolean(verdict2), verdict: verdict2 });
    await cdp.eval('document.querySelector(\'.tab[data-tab="check"]\').click()');
    await sleep(400);
    result.screenshots.push(await shot(cdp, 'iteration.png'));

    result.messages = await cdp.eval(`Array.from(document.querySelectorAll('#messages .msg')).map(e => ({kind: e.className, text: e.textContent.slice(0,220)}))`);
    result.pageExceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => JSON.stringify(e.params).slice(0, 300));
    result.consoleErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map((e) => e.params.entry.text.slice(0, 300));
    result.success = true;
  } catch (e) {
    result.success = false;
    result.error = e.message;
    if (cdp) {
      try { result.messages = await cdp.eval(`Array.from(document.querySelectorAll('#messages .msg')).map(e => e.textContent.slice(0,200))`); } catch {}
    }
  } finally {
    if (cdp) cdp.close();
    if (targetId) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`); } catch {} }
  }

  fs.writeFileSync(path.join(RESULTS, 'e2e_result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2).slice(0, 9000));
  console.log('\n证据文件:', path.join(RESULTS, 'e2e_result.json'));
  process.exit(result.success ? 0 : 1);
}

main();
