'use strict';

/**
 * LLM 接入层：Ollama / OpenAI 兼容双通道。
 * 不依赖任何第三方包；上游流式输出统一转换为前端 SSE 事件。
 * 这里只做真实模型调用，不做任何模板拼装或假生成。
 */

const SYSTEM_PROMPT = `你是「Atoms Demo」里的应用生成 Agent。用户用自然语言描述想要的应用，你负责产出一个完整、可直接运行的单文件网页应用。

硬性规则，逐条遵守：
1. 只输出一个完整 HTML 文档，从 <!DOCTYPE html> 开始，到 </html> 结束。
2. 所有 CSS 写在 <style> 标签内，所有 JavaScript 写在 <script> 标签内。禁止引用任何外部资源：不许有 CDN、外链图片、外链字体、fetch、XMLHttpRequest、import。
3. 用 \`\`\`html 代码块包裹输出；代码块之外不要写任何解释、标题或总结。
4. 应用必须真实可用：包含完整的交互逻辑（增删改、状态切换、计算、筛选等至少一种），不是静态页面骨架，也不是占位演示。
5. 每个按钮、输入框、选择器都必须绑定真实事件处理逻辑，不允许出现装饰性占位控件；点击后界面必须发生可见变化。
6. 界面现代简洁、中文文案、响应式适配；不要使用 alert/confirm/prompt 作为核心交互。
7. 数据只允许存在内存或 localStorage 中，不要依赖任何后端接口。
8. 不要引入 iframe、不要操作 parent、不要访问 document.cookie。

输出前自查：HTML 标签闭合完整、JS 无语法错误、变量先声明后使用、事件绑定的元素确实存在于 DOM 中。`;

const RETRY_HINT = `上一版应用在浏览器里自动冒烟自检未通过，下面是真实采集到的诊断：
{diagnostics}
请针对上述问题修复后，重新输出一个完整的 HTML 文档（仍然只能是 \`\`\`html 代码块）。不要解释，不要只给补丁片段。`;

function buildMessages(payload) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 多轮修改：把当前版本代码作为上一轮助手回复带上，让模型基于真实代码迭代。
  const history = Array.isArray(payload.history) ? payload.history.slice(-6) : [];
  for (const item of history) {
    if (item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') {
      messages.push({ role: item.role, content: item.content.slice(0, 24000) });
    }
  }

  let userText = String(payload.idea || '').slice(0, 4000);
  if (payload.diagnostics && String(payload.diagnostics).trim()) {
    userText += '\n\n' + RETRY_HINT.replace('{diagnostics}', String(payload.diagnostics).slice(0, 2500));
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

/** 从模型原始输出中抽取单个完整 HTML 文档；抽取失败返回 null，绝不补造代码。 */
function extractHtml(raw) {
  if (!raw) return null;
  let text = String(raw);
  const fenced = text.match(/```(?:html|HTML)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const start = text.search(/<!DOCTYPE\s+html/i);
  const startIdx = start >= 0 ? start : text.search(/<html[\s>]/i);
  if (startIdx < 0) return null;
  const endIdx = text.toLowerCase().lastIndexOf('</html>');
  if (endIdx < 0) return null;
  const html = text.slice(startIdx, endIdx + 7).trim();
  if (html.length < 200) return null;
  return html;
}

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
