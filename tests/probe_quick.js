'use strict';

/**
 * 探针快速自测：用一份已生成的样本 HTML 在真实浏览器 iframe 沙箱里跑自检，
 * 不调用模型，用于开发期快速验证探针本身。
 * 用法：node tests/probe_quick.js [样本HTML路径]
 * 输出：tests/results/probe_result.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = path.join(ROOT, 'tests', 'results');
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const samplePath = process.argv[2] || 'C:/tmp/atoms_first.html';

const SAMPLE = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>探针样本</title></head><body>
<h1>待办清单</h1><input id="x" placeholder="输入任务"><button id="b">添加</button><ul id="l"></ul>
<script>document.getElementById('b').onclick=function(){var v=document.getElementById('x').value||'新任务';var li=document.createElement('li');li.textContent=v;document.getElementById('l').appendChild(li);};</scr` + `ipt>
</body></html>`;

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const html = fs.existsSync(samplePath) ? fs.readFileSync(samplePath, 'utf8') : SAMPLE;
  const probe = await (await fetch(BASE + '/probe.js')).text();
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  const out = { timestamp: new Date().toISOString(), sample: samplePath, sampleBytes: Buffer.byteLength(html) };
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await evaluate(`(function(){
      window.__probeResult = null;
      window.addEventListener('message', function(e){ if(e.data && e.data.__atomsProbe && e.data.type==='selfcheck') window.__probeResult = e.data.payload; });
      var f = document.createElement('iframe');
      f.sandbox = 'allow-scripts'; f.style.cssText='width:640px;height:420px';
      document.body.appendChild(f);
      var o='<scr'+'ipt>', c='</scr'+'ipt>';
      var tag = o + 'window.__ATOMS_TOKEN__="quick-token";' + c + o + ${JSON.stringify(probe)} + c;
      var html = ${JSON.stringify(html)};
      f.srcdoc = html.replace(/<head[^>]*>/i, function(m){ return m + tag; });
    })()`);

    const start = Date.now();
    for (;;) {
      const r = await evaluate('window.__probeResult');
      if (r) { out.probe = r; break; }
      if (Date.now() - start > 20000) throw new Error('探针 20 秒内未回报');
      await new Promise((x) => setTimeout(x, 300));
    }
    out.success = true;
    out.summary = {
      verdict: out.probe.verdict,
      checks: out.probe.checks.map((c) => c.name + '=' + c.status),
      stats: out.probe.stats,
      errors: out.probe.errors,
      warns: out.probe.warns
    };
  } catch (e) {
    out.success = false;
    out.error = e.message;
  } finally {
    ws.close();
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${t.id}`); } catch {}
  }
  fs.writeFileSync(path.join(RESULTS, 'probe_result.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out.summary || out, null, 2));
  console.log('证据:', path.join(RESULTS, 'probe_result.json'));
  process.exit(out.success && out.probe && out.probe.verdict !== 'warn' ? 0 : 1);
}

main();
