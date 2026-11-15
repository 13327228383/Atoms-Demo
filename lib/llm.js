'use strict';

/**
 * LLM 接入层：Ollama / OpenAI 兼容双通道。
 * 不依赖任何第三方包；上游流式输出统一转换为前端 SSE 事件。
 * 这里只做真实模型调用，不做任何模板拼装或假生成。
 */

const shared = require('../public/shared.js');
const { SYSTEM_PROMPT, RETRY_HINT, buildMessages, extractHtml } = shared;

/** 把上游流式响应解析成前端统一的 delta 事件。 */
async function streamCompletion({ provider, config, messages, onDelta, signal }) {
  if (provider === 'ollama') {
    const url = config.ollamaBaseUrl.replace(/\/$/, '') + '/api/chat';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        stream: true,
        options: { temperature: 0.6, num_predict: 4096 }
      }),
      signal
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) throw new Error(`Ollama: ${obj.error}`);
        const piece = obj.message && obj.message.content;
        if (piece) onDelta(piece);
      }
    }
    return;
  }

  if (provider === 'openai') {
    const url = config.openaiBaseUrl.replace(/\/$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: config.openaiModel,
        messages,
        stream: true,
        temperature: 0.6
      }),
      signal
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        if (obj.error) throw new Error(`LLM: ${obj.error.message || JSON.stringify(obj.error)}`);
        const piece = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
        if (piece) onDelta(piece);
      }
    }
    return;
  }

  throw new Error(`未知的 LLM_PROVIDER: ${provider}`);
}

/** 主动探测模型是否真的可调，供前端展示真实状态，避免"看起来能用"。 */
async function probeModels(config, provider) {
  try {
    if (provider === 'ollama') {
      const res = await fetch(config.ollamaBaseUrl.replace(/\/$/, '') + '/api/tags', {
        signal: AbortSignal.timeout(2500)
      });
      if (!res.ok) return { online: false, models: [] };
      const data = await res.json();
      return { online: true, models: (data.models || []).map((m) => m.name) };
    }
    return { online: Boolean(config.openaiApiKey), models: config.openaiApiKey ? [config.openaiModel] : [] };
  } catch {
    return { online: false, models: [] };
  }
}

module.exports = { buildMessages, extractHtml, streamCompletion, probeModels, SYSTEM_PROMPT };
