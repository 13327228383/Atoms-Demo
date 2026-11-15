'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  versions: [],
  activeId: null,
  generating: false,
  probeCode: '',
  config: null,
  activeCheck: null,
  retryUsed: {}
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

function setGenerating(on) {
  state.generating = on;
  $('sendBtn').disabled = on;
  $('sendBtn').textContent = on ? '生成中' : '生成';
  $('idea').disabled = on;
  $('versionSelect').disabled = on || state.versions.length === 0;
}

function currentVersion() {
  return state.versions.find((v) => v.id === state.activeId) || null;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('SDK 加载失败：' + src));
    document.head.appendChild(s);
  });
}

/** 云端免密钥模式：初始化 SDK 并从真实模型目录里选一个可用模型。 */
async function ensureCloud() {
  if (state.cloud && state.cloud.client && state.cloud.model) return state.cloud;
  const cfg = window.__WB_PUBLIC_CONFIG__;
  if (!cfg || !cfg.endpoint || !cfg.publishableKey) throw new Error('缺少云端 publicConfig，无法初始化免密钥模型');
  if (!window.WorkBuddyCloud) {
    // SDK 的 IIFE 构建同源托管：jsDelivr 在部分网络下不可达，避免线上打开就失败。
    await loadScript('/vendor/workbuddy-cloud-sdk.js');
  }
  const WB = window.WorkBuddyCloud;
  if (!WB || !WB.createWorkBuddyCloud) throw new Error('云端 SDK 加载后未暴露 createWorkBuddyCloud');
  const client = WB.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    publishableKey: cfg.publishableKey
  });
  const models = await client.llm.models.list();
  if (!Array.isArray(models) || !models.length) throw new Error('云端模型目录为空，无法生成');
  const usable = (m) => m && m.enabled !== false && m.disabled !== true;
  // 优先 0 积分模型，其次低倍率快速编码模型；列表为空时不硬编码兜底模型 id。
  const preferred = ['hy4free', 'hy3', 'space-bunny', 'minimax-m3.1-flash', 'deepseek-v4.1-flash'];
  let model = null;
  for (const id of preferred) {
    model = models.find((m) => m.id === id && usable(m));
    if (model) break;
  }
  if (!model) model = models.find(usable);
  if (!model) throw new Error('云端模型目录中没有可用模型');
  state.cloud = { client, model };
  return state.cloud;
}

/** 浏览器直连云 LLM：messages[0] 必须是 system，且只支持流式。 */
async function generateViaCloud(idea, opts, cb) {
  cb.onStatus('正在初始化云端免密钥模型…');
  const { client, model } = await ensureCloud();
  const messages = window.AtomsShared.buildMessages({
    idea: cloudText(idea),
    history: buildHistory(),
    diagnostics: cloudText(opts.diagnostics || '')
  });
  cb.onStatus(`正在调用 ${model.name || model.id} 生成应用…`);
  let raw = '';
  for await (const chunk of client.llm.chat.completions.create({
    model: model.id,
    messages,
    stream: true
  })) {
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    const piece = delta && delta.content;
    if (piece) { raw += piece; cb.onDelta(piece); }
  }
  const html = window.AtomsShared.extractHtml(raw);
  if (!html) {
    cb.onError(`模型返回了 ${raw.length} 字符，但未能抽取出完整 HTML 文档。这是真实失败，不做补造；可重试。`);
    return;
  }
  cb.onDone({ html, rawLength: raw.length, model: model.name || model.id });
}

/** 自托管模式：SSE 走本地 Node 后端（Ollama / OpenAI 兼容）。 */
async function generateViaBackend(idea, opts, cb) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idea,
      history: buildHistory(),
      diagnostics: opts.diagnostics || ''
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === 'status') cb.onStatus(ev.message);
      else if (ev.type === 'delta') cb.onDelta(ev.text);
      else if (ev.type === 'done') cb.onDone(ev);
      else if (ev.type === 'error') cb.onError(ev.message);
    }
  }
}

function updateVersionSelect() {
  const sel = $('versionSelect');
  sel.innerHTML = '';
  state.versions.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = `v${i + 1} · ${v.idea.slice(0, 12)}${v.isRetry ? '（自检修复）' : ''}`;
    sel.appendChild(opt);
  });
  sel.value = state.activeId || '';
  sel.disabled = state.generating || state.versions.length === 0;
  const has = Boolean(currentVersion());
  $('downloadBtn').disabled = !has;
  $('copyBtn').disabled = !has;
  $('refreshBtn').disabled = !has;
}

function updateCode() {
  const v = currentVersion();
  $('codeView').textContent = v ? v.html : '// 生成后可在此查看完整源码，并一键下载';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

function injectProbe(html, token) {
  const open = '<scr' + 'ipt>';
  const close = '</scr' + 'ipt>';
  const tag = open + 'window.__ATOMS_TOKEN__=' + JSON.stringify(token) + ';' + close + open + state.probeCode + close;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
  return tag + html;
}

function renderPreview(v, withProbe) {
  $('empty').classList.add('hidden');
  $('previewWrap').classList.remove('hidden');
  const iframe = $('preview');
  if (!withProbe) {
    iframe.srcdoc = v.html;
    return;
  }
  const token = 'chk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const ac = { token, versionId: v.id, done: false, timer: null };
  state.activeCheck = ac;
  ac.timer = setTimeout(() => {
    if (ac.done || state.activeCheck !== ac) return;
    ac.done = true;
    const target = state.versions.find((x) => x.id === ac.versionId);
    if (target) {
      target.report = {
        verdict: 'warn',
        checks: [{ name: '探针回报', status: 'warn', detail: '12 秒内未收到自检结果：生成的应用可能重载了页面、阻断了脚本，或渲染耗时过长。未据此判定通过。' }],
        diagnostics: '- 探针超时，无自检结论',
        stats: {}, errors: [], warns: []
      };
      if (state.activeId === ac.versionId) renderReport(target);
    }
    if (state.activeId === ac.versionId) renderPreview(v, false);
  }, 12000);
  iframe.srcdoc = injectProbe(v.html, token);
}

function renderReport(v) {
  const r = v && v.report;
  if (!r) {
    const checking = Boolean(v && state.activeCheck && !state.activeCheck.done && state.activeCheck.versionId === v.id);
    $('checkView').innerHTML = `<div class="check-empty">${checking ? '正在浏览器沙箱内执行自动冒烟自检…' : '尚未运行自检。生成完成后会自动执行。'}</div>`;
    $('checkDot').className = checking ? 'dot warn' : 'dot';
    return;
  }
  $('checkDot').className = 'dot ' + (r.verdict === 'pass' ? 'ok' : r.verdict === 'fail' ? 'bad' : 'warn');
  const label = r.verdict === 'pass' ? '自检通过' : r.verdict === 'fail' ? '自检未通过 · 已回灌 Agent 修复' : '自检未完成';
  const cls = r.verdict === 'pass' ? 'pass' : r.verdict === 'fail' ? 'fail' : 'warn';
  const s = r.stats || {};
  const items = (r.checks || []).map((c) =>
    `<div class="check-item ${c.status}"><div class="icon"></div><div class="body">
      <div class="title">${escapeHtml(c.name)}</div>
      <div class="detail">${escapeHtml(c.detail)}</div>
    </div></div>`).join('');
  const warns = (r.warns || []).length
    ? `<div class="note">沙箱说明：${(r.warns || []).map(escapeHtml).join('；')}</div>` : '';
  $('checkView').innerHTML = `
    <div class="check-head">
      <span class="verdict ${cls}">${label}</span>
      <span class="check-meta">
        可见文本 ${s.textLen != null ? s.textLen : '-'} 字符 · DOM ${s.nodeCount != null ? s.nodeCount : '-'} 节点 ·
        控件 ${s.interactiveCount != null ? s.interactiveCount : '-'} 个 ·
        真实点击 ${s.clicked != null ? s.clicked : '-'} 次（${s.changed != null ? s.changed : '-'} 次有可见变化）
      </span>
    </div>
    <div class="check-list">${items}</div>
    <button class="btn ghost sm recheck" id="recheckBtn" type="button">重新自检</button>
    ${warns}
    <div class="note">自检探针注入在预览 iframe 内真实执行：捕获未捕获异常与 console.error、统计 DOM 渲染、清点可交互控件、
    真实点击最多 3 个按钮并比对点击前后的可见文本变化。失败项会原文回灌给模型自动重生成一次；探针超时不会被算作通过。
    预览随后会重新载入不含探针的原始代码，导出的 HTML 也不含探针。</div>`;
  $('recheckBtn').addEventListener('click', () => {
    const ver = currentVersion();
    if (ver) {
      ver.report = null;
      renderReport(ver);
      renderPreview(ver, true);
      switchTab('check');
    }
  });
}

/**
 * 云端通道的请求体不能出现 ASCII 尖括号：发布域前置的腾讯云 WAF 会把
 * HTML 标签字面量判成 XSS 并直接返回 403 拦截页（实测 60ms 内拦截）。
 * 换成单书名号只影响传输，用户看到的仍是原文；模型返回的 HTML 属于响应体，
 * 不受请求侧规则约束。本地自托管通道无需此处理。
 */
function cloudText(s) {
  return String(s == null ? '' : s).replace(/</g, '‹').replace(/>/g, '›');
}

/** 把上一版应用转成不含尖括号的纯文本结构摘要，供云端多轮对话使用。 */
function summarizeHtml(html) {
  const strip = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headings = Array.from(html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)).map((m) => strip(m[1])).filter(Boolean).slice(0, 4);
  const buttons = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)).map((m) => strip(m[1])).filter(Boolean).slice(0, 8);
  const inputs = (html.match(/<input\b/gi) || []).length;
  const selects = (html.match(/<select\b/gi) || []).length;
  const lines = ['上一版应用的结构摘要（纯文本，不是源码）：'];
  if (titleM) lines.push('页面标题：' + strip(titleM[1]));
  if (headings.length) lines.push('标题文案：' + headings.join('、'));
  if (buttons.length) lines.push('按钮文案：' + buttons.join('、'));
  lines.push(`输入框 ${inputs} 个、下拉选择 ${selects} 个`);
  lines.push('请结合这份摘要与本次修改要求，重新输出完整的新版单文件网页应用（仍用 html 代码块包裹）。');
  return lines.join('\n');
}

function buildHistory() {
  // 云端经 WAF：回传完整 HTML 源码会被拦截，改传等价的结构摘要；
  // 本地自托管仍回传完整源码，保持「基于当前代码迭代」的能力。
  const cloud = Boolean(state.config && state.config.provider === 'cloud');
  const h = [];
  state.versions.slice(-2).forEach((v) => {
    h.push({ role: 'user', content: cloud ? cloudText(v.idea) : v.idea });
    h.push({
      role: 'assistant',
      content: cloud ? cloudText(summarizeHtml(v.html)) : ('```html\n' + v.html + '\n```')
    });
  });
  return h;
}

async function generate(idea, opts) {
  opts = opts || {};
  if (state.generating || !idea.trim()) return;
  setGenerating(true);

  if (!opts.isRetry) addMsg('user', idea);
  const statusEl = addMsg('status', '准备生成…');
  const streamEl = addMsg('stream', '');
  let rawLen = 0;
  let tail = '';
  let finished = false;

  const cb = {
    onStatus: (m) => { statusEl.textContent = m; },
    onDelta: (text) => {
      rawLen += text.length;
      tail = (tail + text).slice(-140);
      streamEl.textContent = `已生成 ${rawLen} 字符…\n…${tail}`;
    },
    onDone: (ev) => {
      if (finished) return;
      finished = true;
      statusEl.textContent = `生成完成 · ${ev.model} · ${ev.rawLength} 字符`;
      streamEl.remove();
      const v = {
        id: 'v' + Date.now() + Math.random().toString(36).slice(2, 6),
        idea,
        html: ev.html,
        model: ev.model,
        report: null,
        isRetry: Boolean(opts.isRetry),
        at: Date.now()
      };
      state.versions.push(v);
      state.activeId = v.id;
      updateVersionSelect();
      updateCode();
      switchTab('preview');
      renderReport(null);
      renderPreview(v, true);
      addMsg('agent', `已生成 v${state.versions.length}（${ev.html.length} 字符单文件 HTML），正在浏览器沙箱内自动冒烟自检…`);
    },
    onError: (msg) => {
      if (finished) return;
      finished = true;
      statusEl.remove();
      streamEl.remove();
      addMsg('error', '生成失败：' + msg);
    }
  };

  try {
    if (state.config && state.config.provider === 'cloud') await generateViaCloud(idea, opts, cb);
    else await generateViaBackend(idea, opts, cb);
  } catch (e) {
    cb.onError(e.message);
  } finally {
    setGenerating(false);
  }
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__atomsProbe || d.type !== 'selfcheck') return;
  const ac = state.activeCheck;
  if (!ac || ac.done || d.token !== ac.token) return;
  if (e.source && e.source !== $('preview').contentWindow) return;
  ac.done = true;
  clearTimeout(ac.timer);

  const v = state.versions.find((x) => x.id === ac.versionId);
  if (!v) return;
  v.report = d.payload;
  // 只刷新当前正在查看的版本，避免后台版本的自检结果覆盖用户眼前的报告
  if (state.activeId === v.id) {
    renderReport(v);
    renderPreview(v, false);
  }

  const failed = (d.payload.checks || []).filter((c) => c.status === 'fail');
  if (d.payload.verdict === 'pass') {
    addMsg('ok', `v${state.versions.indexOf(v) + 1} 自检通过：${(d.payload.checks || []).length} 项检查，${(d.payload.stats || {}).clicked || 0} 次真实点击探测。可继续用对话修改，或下载 HTML。`);
  } else if (!state.retryUsed[v.id] && d.payload.verdict === 'fail') {
    state.retryUsed[v.id] = true;
    addMsg('status', `自检未通过（${failed.length} 项失败），正在把真实诊断回灌给 Agent 自动修复…`);
    setTimeout(() => generate(v.idea, { isRetry: true, diagnostics: d.payload.diagnostics }), 350);
  } else {
    addMsg('error', `自检仍未通过（${failed.length} 项失败），已停止自动重试。诊断：${(d.payload.diagnostics || '').slice(0, 400)}`);
  }
});

function resetAll() {
  if (state.generating) return;
  state.versions = [];
  state.activeId = null;
  state.retryUsed = {};
  if (state.activeCheck) { clearTimeout(state.activeCheck.timer); state.activeCheck = null; }
  $('messages').innerHTML = '';
  $('preview').srcdoc = '';
  $('previewWrap').classList.add('hidden');
  $('empty').classList.remove('hidden');
  $('suggestions').classList.remove('hidden');
  updateVersionSelect();
  updateCode();
  renderReport(null);
  addMsg('agent', '新会话已开始。描述一个你想要的应用，我会生成一个完整可运行的单文件网页应用，并自动做浏览器冒烟自检。');
}

async function init() {
  addMsg('agent', '欢迎。描述一个你想要的应用，我会生成一个完整可运行的单文件网页应用，在右侧实时预览，并自动做浏览器冒烟自检。');
  try {
    state.probeCode = await (await fetch('/probe.js')).text();
  } catch (e) {
    addMsg('error', '自检探针加载失败：' + e.message + '（自检功能不可用，生成与预览仍可正常使用）');
  }
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.config = cfg;
    const badge = $('modelBadge');
    if (cfg.provider === 'cloud') {
      badge.className = 'badge';
      badge.textContent = '检测云端模型中…';
      try {
        const cloud = await ensureCloud();
        badge.className = 'badge online';
        badge.textContent = '● ' + (cloud.model.name || cloud.model.id) + ' 在线';
      } catch (e) {
        badge.className = 'badge offline';
        badge.textContent = '● 云端模型不可用';
        addMsg('error', '云端模型初始化失败：' + e.message + '。生成会如实报错，不会返回假结果。');
      }
    } else if (cfg.modelOnline) {
      badge.className = 'badge online';
      badge.textContent = '● ' + cfg.model + ' 在线';
    } else {
      badge.className = 'badge offline';
      badge.textContent = '● 模型离线 · ' + cfg.model;
      addMsg('error', '模型探测为离线：生成会真实报错而不是返回假结果。请确认 Ollama 已启动，或改用 OpenAI 兼容接口。');
    }
  } catch (e) {
    $('modelBadge').textContent = '配置读取失败';
  }

  $('sendBtn').addEventListener('click', () => {
    const idea = $('idea').value.trim();
    if (!idea || state.generating) return;
    $('idea').value = '';
    $('suggestions').classList.add('hidden');
    generate(idea, {});
  });
  $('idea').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('sendBtn').click();
    }
  });
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('idea').value = chip.textContent;
      $('sendBtn').click();
    });
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $('newBtn').addEventListener('click', resetAll);
  $('versionSelect').addEventListener('change', (e) => {
    state.activeId = e.target.value;
    const v = currentVersion();
    if (!v) return;
    updateCode();
    renderReport(v);
    renderPreview(v, false);
  });
  $('refreshBtn').addEventListener('click', () => {
    const v = currentVersion();
    if (v) renderPreview(v, false);
  });
  $('downloadBtn').addEventListener('click', () => {
    const v = currentVersion();
    if (!v) return;
    const blob = new Blob([v.html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atoms-app-${v.id}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('copyBtn').addEventListener('click', async () => {
    const v = currentVersion();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v.html);
      addMsg('ok', '完整源码已复制到剪贴板。');
    } catch (e) {
      addMsg('error', '复制失败：' + e.message);
    }
  });
}

init();
