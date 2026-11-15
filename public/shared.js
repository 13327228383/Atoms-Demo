'use strict';

/*
 * 前后端共用的生成契约：系统提示词、消息组装、HTML 抽取。
 * 服务端（lib/llm.js）用 CommonJS require，浏览器用全局变量 AtomsShared，
 * 保证「本地后端模式」与「云端免密钥模式」用完全相同的规则，不会各自漂移。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtomsShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /*
   * 注意：这里刻意不写任何形如 <script> / <!DOCTYPE ...> 的尖括号字面量。
   * 线上发布域前置了腾讯云 WAF，实测只要请求体里出现 HTML 标签字面量，
   * chat/completions 会在 60ms 内被判为 XSS 攻击并返回 403 拦截页（见
   * tests/results/online/ 的诊断记录）。改用等价的自然语言描述后，
   * 模型依然会输出标准 HTML 文档，而请求体不再触发规则。
   */
  const SYSTEM_PROMPT = `你是「Atoms Demo」里的应用生成 Agent。用户用自然语言描述想要的应用，你负责产出一个完整、可直接运行的单文件网页应用。

硬性规则，逐条遵守：
1. 只输出一个完整 HTML 文档，以标准 HTML5 文档声明开头，以 html 结束标签收尾。
2. 所有 CSS 内联写在 style 元素内，所有 JavaScript 内联写在 script 元素内。禁止引用任何外部资源：不许有 CDN、外链图片、外链字体；不许发起网络请求，不许使用模块导入。
3. 用 markdown 的 html 代码块包裹输出；代码块之外不要写任何解释、标题或总结。
4. 应用必须真实可用：包含完整的交互逻辑（增删改、状态切换、计算、筛选等至少一种），不是静态页面骨架，也不是占位演示。
5. 每个按钮、输入框、选择器都必须绑定真实事件处理逻辑，不允许出现装饰性占位控件；点击后界面必须发生可见变化。
6. 界面现代简洁、中文文案、响应式适配；不要用浏览器弹窗作为核心交互。
7. 数据只允许存在内存或浏览器本地存储中，不要依赖任何后端接口。
8. 不要嵌入子页面、不要访问父页面、不要读写 cookie。

输出前自查：标签闭合完整、脚本无语法错误、变量先声明后使用、事件绑定的元素确实存在于 DOM 中。`;

  const RETRY_HINT = `上一版应用在浏览器里自动冒烟自检未通过，下面是真实采集到的诊断：
{diagnostics}
请针对上述问题修复后，重新输出一个完整的 HTML 文档（仍然只能是 \`\`\`html 代码块）。不要解释，不要只给补丁片段。`;

  function buildMessages(payload) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

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

  return { SYSTEM_PROMPT, RETRY_HINT, buildMessages, extractHtml };
});
