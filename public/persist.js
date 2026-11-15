'use strict';

/*
 * 浏览器侧真实持久化：完整版本（含 HTML 源码）存 localStorage，刷新后可恢复。
 * 同时把「元数据摘要」同步到服务端 SQLite；摘要里绝不携带 HTML 标签字面量，
 * 否则线上发布域的 WAF 会按 XSS 规则拦截请求体（见 WAF_ROOTCAUSE.md）。
 * 任何一层失败都如实反映在状态徽章上，不伪造「已保存」。
 */
(function () {
  var KEY = 'atoms-demo-session-v1';
  var ID_KEY = KEY + '-id';

  function safeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function safeDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  function sessionId() {
    var s = safeGet(ID_KEY);
    if (!s) {
      s = 's' + Date.now() + Math.random().toString(36).slice(2, 8);
      safeSet(ID_KEY, s);
    }
    return s;
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/</g, '‹').replace(/>/g, '›');
  }

  function badge(text) {
    var el = document.getElementById('persistBadge');
    if (el) el.textContent = text;
  }

  function restore() {
    var raw = safeGet(KEY);
    if (!raw) return null;
    try {
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.versions) || d.versions.length === 0) return null;
      return d;
    } catch (e) { return null; }
  }

  function clear() {
    safeDel(KEY);
    badge('● 新会话 · 待生成');
  }

  function sync(state, localOk) {
    var payload = {
      id: sessionId(),
      provider: (state.config && state.config.provider) || 'unknown',
      versions: state.versions.map(function (v) {
        return {
          id: v.id,
          idea: clean(v.idea),
          model: clean(v.model),
          htmlLength: (v.html || '').length,
          verdict: (v.report && v.report.verdict) || null,
          at: v.at
        };
      }),
      activeId: state.activeId,
      updatedAt: Date.now()
    };
    if (localOk) badge('● 已持久化 · 本地 ' + state.versions.length + ' 个版本');
    else badge('● 本地存储不可用');
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (x) {
      if (!x.ok) throw new Error(x.j && x.j.error ? x.j.error : 'HTTP ' + x.ok);
      badge('● 已持久化 · 本地 + ' + (x.j.engine || '服务端'));
    }).catch(function (e) {
      badge('● ' + (localOk ? '本地已持久化' : '本地不可用') + ' · 服务端同步失败');
    });
  }

  function save(state) {
    var ok = safeSet(KEY, JSON.stringify({
      versions: state.versions,
      activeId: state.activeId,
      at: Date.now()
    }));
    sync(state, ok);
    return ok;
  }

  window.AtomsPersist = {
    save: save, restore: restore, clear: clear,
    badge: badge, sessionId: sessionId
  };
})();
