/*
 * Atoms Demo 浏览器冒烟自检探针
 * 由主页面注入到预览 iframe 的 <head> 最前面，真实采集运行时证据。
 * 检测项：未捕获异常 / DOM 渲染 / 可交互控件 / 离线自包含 / 真实点击后的可见变化。
 * 结果通过 postMessage 回传父页面，父页面只接受 token 匹配的一次结果。
 */
(function () {
  var errors = [];
  var warns = [];
  var MAX = 20;
  var token = window.__ATOMS_TOKEN__ || '';

  function push(arr, s) {
    if (arr.length < MAX && s) arr.push(String(s).slice(0, 320));
  }

  // 不透明源下 localStorage 会抛 SecurityError，提供内存垫片并如实记一条说明。
  // 只替换存储实现，不改应用的任何 UI / 交互逻辑；导出的 HTML 不含此垫片。
  try {
    var probeStore = window.localStorage;
    if (!probeStore) throw new Error('no storage');
  } catch (e) {
    try {
      var mem = {};
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
          setItem: function (k, v) { mem[k] = String(v); },
          removeItem: function (k) { delete mem[k]; },
          clear: function () { mem = {}; },
          key: function (i) { return Object.keys(mem)[i] || null; },
          get length() { return Object.keys(mem).length; }
        }
      });
      push(warns, '预览沙箱为不透明源，已用内存垫片替代 localStorage；导出文件使用原生 localStorage');
    } catch (e2) { push(warns, '存储垫片未生效: ' + e2.message); }
  }

  window.addEventListener('error', function (e) {
    if (!e.message && e.target && e.target !== window) {
      push(warns, '资源加载失败: ' + (e.target.src || e.target.href || '未知资源'));
      return;
    }
    push(errors, '未捕获异常: ' + (e.message || 'unknown') + (e.lineno ? ' @行' + e.lineno : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    push(errors, 'Promise 未处理拒绝: ' + ((r && (r.message || r)) || 'unknown'));
  });

  var origError = console.error;
  console.error = function () {
    var parts = Array.prototype.map.call(arguments, function (a) {
      return (a && a.message) ? a.message : String(a);
    });
    push(errors, 'console.error: ' + parts.join(' ').slice(0, 260));
    if (origError) { try { origError.apply(console, arguments); } catch (e3) {} }
  };

  function send(payload) {
    try {
      parent.postMessage({ __atomsProbe: true, type: 'selfcheck', token: token, payload: payload }, '*');
    } catch (e) {}
  }

  function snapshot() {
    try { return (document.body && document.body.innerText || '').slice(0, 4000); } catch (e) { return ''; }
  }

  function run() {
    var checks = [];
    var body = document.body;
    var text = body ? (body.innerText || '').trim() : '';
    var textLen = text.length;
    var nodeCount = body ? body.querySelectorAll('*').length : 0;
    var interactive = body ? body.querySelectorAll('button, input, select, textarea, [role="button"], [contenteditable="true"]') : [];
    var externalEls = document.querySelectorAll('script[src], link[href], img[src]');
    var externalCount = 0;
    for (var i = 0; i < externalEls.length; i++) {
      var u = externalEls[i].getAttribute('src') || externalEls[i].getAttribute('href') || '';
      if (/^https?:\/\//i.test(u)) externalCount++;
    }

    checks.push({
      name: 'JavaScript 运行时',
      status: errors.length ? 'fail' : 'pass',
      detail: errors.length ? ('捕获 ' + errors.length + ' 条错误：' + errors.slice(0, 3).join(' | ')) : '未捕获异常、console.error 与未处理的 Promise 拒绝均为 0'
    });
    checks.push({
      name: 'DOM 实际渲染',
      status: (textLen > 0 && nodeCount >= 3) ? 'pass' : 'fail',
      detail: '可见文本 ' + textLen + ' 字符，DOM 节点 ' + nodeCount + ' 个（初始态只要求有实际渲染内容，不用文本长度卡阈值）'
    });
    checks.push({
      name: '可交互控件',
      status: interactive.length ? 'pass' : 'fail',
      detail: '检出 ' + interactive.length + ' 个控件（button / input / select / textarea / role=button）'
    });
    checks.push({
      name: '离线自包含',
      status: externalCount ? 'warn' : 'pass',
      detail: externalCount ? ('发现 ' + externalCount + ' 个外链资源，可能导致离线打开时失效') : '无外链脚本、样式或图片，单文件可直接打开'
    });

    var candidates = [];
    var skipped = 0;
    for (var j = 0; j < interactive.length && candidates.length < 6; j++) {
      var el = interactive[j];
      if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
      // button 无 type 时浏览器默认就是 submit；只有真的处在 form 内才跳过，避免把普通按钮全跳过
      if (el.type === 'submit' && el.closest('form')) { skipped++; continue; }
      var label = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (/删除|清空|重置|下载|导出|刷新|支付|提交|打印|跳转/.test(label)) { skipped++; continue; }
      candidates.push(el);
    }

    var idx = 0, clicked = 0, changed = 0, clickResults = [];

    function finish() {
      checks.push({
        name: '真实点击探测',
        status: clicked === 0 ? 'warn' : (changed > 0 ? 'pass' : 'warn'),
        detail: clicked === 0
          ? '没有可安全点击的按钮（跳过 ' + skipped + ' 个），未做交互探测'
          : ('点击 ' + clicked + ' 个按钮，' + changed + ' 次引发可见 DOM 变化（点击前已给空文本框填入测试值「自检」，共填 ' + clickResults.reduce(function (a, r) { return a + (r.filled || 0); }, 0) + ' 次）；明细：' + clickResults.map(function (r) {
              return r.label + (r.changed ? '→有变化' : '→无变化') + (r.newErrors ? '→新增' + r.newErrors + '错误' : '');
            }).join('、'))
      });
      var clickErrors = 0;
      for (var k = 0; k < clickResults.length; k++) clickErrors += clickResults[k].newErrors;
      if (clickErrors > 0) {
        checks.push({ name: '交互期间异常', status: 'fail', detail: '点击过程中新增 ' + clickErrors + ' 条运行时错误' });
      }

      var failed = checks.filter(function (c) { return c.status === 'fail'; });
      var diagnostics = failed.map(function (c) { return '- ' + c.name + '：' + c.detail; });
      if (errors.length) diagnostics.push('- 原始错误：' + errors.slice(0, 5).join(' | '));

      send({
        token: token,
        verdict: failed.length ? 'fail' : 'pass',
        checks: checks,
        errors: errors,
        warns: warns,
        stats: {
          textLen: textLen, nodeCount: nodeCount, interactiveCount: interactive.length,
          externalCount: externalCount, clicked: clicked, changed: changed, skipped: skipped
        },
        diagnostics: diagnostics.join('\n'),
        ts: Date.now()
      });
    }

    function next() {
      if (idx >= candidates.length || clicked >= 3) { finish(); return; }
      var el = candidates[idx++];
      var label = (el.innerText || el.getAttribute('aria-label') || '按钮').trim().slice(0, 24) || '按钮';
      // 为可复现地验证交互，先给空文本框填入测试值（模拟真实用户输入），并在报告中如实标注
      var filled = 0;
      var inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (var q = 0; q < Math.min(inputs.length, 2); q++) {
        try {
          if (!inputs[q].value) {
            inputs[q].value = '自检';
            inputs[q].dispatchEvent(new Event('input', { bubbles: true }));
            filled++;
          }
        } catch (e) {}
      }
      var before = snapshot();
      var errBefore = errors.length;
      try { el.click(); clicked++; } catch (e) { push(errors, '点击 "' + label + '" 抛异常: ' + e.message); }
      setTimeout(function () {
        var didChange = snapshot() !== before;
        if (didChange) changed++;
        clickResults.push({ label: label, changed: didChange, newErrors: errors.length - errBefore, filled: filled });
        next();
      }, 160);
    }
    next();
  }

  function boot() { setTimeout(run, 700); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
