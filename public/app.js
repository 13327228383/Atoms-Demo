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

function buildHistory() {
  const h = [];
  state.versions.slice(-2).forEach((v) => {
    h.push({ role: 'user', content: v.idea });
    h.push({ role: 'assistant', content: '```html\n' + v.html + '\n```' });
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

  try {
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
        if (ev.type === 'status') statusEl.textContent = ev.message;
        else if (ev.type === 'delta') {
          rawLen += ev.text.length;
          tail = (tail + ev.text).slice(-140);
          streamEl.textContent = `已生成 ${rawLen} 字符…\n…${tail}`;
        } else if (ev.type === 'done') {
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
        } else if (ev.type === 'error') {
          statusEl.remove();
          streamEl.remove();
          addMsg('error', '生成失败：' + ev.message);
        }
      }
    }
  } catch (e) {
    statusEl.remove();
    streamEl.remove();
    addMsg('error', '请求失败：' + e.message);
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
    if (cfg.modelOnline) {
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
