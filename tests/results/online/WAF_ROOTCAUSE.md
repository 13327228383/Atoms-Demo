# 线上「点生成即失败」的 WAF 根因定位记录

日期：2026-11-15
定位方式：真实浏览器（CDP 驱动 Chromium）在线上页面上下文里直接调用云端 SDK，同时抓 `Network.responseReceived`。所有结论来自实测，不是推断。

## 现象

线上 Demo 首页模型徽章显示 `● Hy4 在线`，`GET /health` 返回 200、`.cloud/llm/models` 返回 200，但点击「生成」后约 1 秒内出现：

```
生成失败：<!DOCTYPE html><html lang="en">...<title>WAF拦截页面</title>...
您的请求已中断 / Web应用防护服务检测您当前访问存在Web安全风险或访问不合规
请求UUID：1f80dae3-8baf-4433-947d-801adfa2056b
```

原始失败记录：`e2e_result_before_waf_fix.json`（`success: false`，`messages[2]` 为 WAF 拦截页）。
第一次 E2E 还暴露了脚本缺陷：生成已失败但脚本仍空等自检报告直到 420s 超时，已在 `tests/e2e_cdp.js` 中加入「检测到 `.msg.error` 立即失败」。

## 取证结果

| # | 用例 | 请求体特征 | `.cloud/llm/chat/completions` 状态 | 结论 |
|---|---|---|---|---|
| 1 | `models.list()` | — | `.cloud/llm/models` → 200 JSON | 鉴权 / Origin / SDK 初始化正常 |
| 2 | 极小 prompt | `system: "You are a helpful assistant."` + `user: "Say hi"` | **200 `text/event-stream`**，返回 `Hi there! How can I help you today?` | 路径、鉴权、模型都可用 |
| 3 | 原始 `SYSTEM_PROMPT` | 含 `<!DOCTYPE html>`、`<style>`、`<script>`、`</html>` 等标签字面量 | **403 `text/html`**（WAF 拦截页，约 60ms） | 请求体内容触发规则 |
| 4 | 改写后的 prompt（第一轮） | 同样规则，但全部改成不含尖括号的自然语言描述 | **200 `text/event-stream`**（诊断 guard 设 45s 过短未等完，但请求已放行） | 去掉尖括号即可通过 |
| 5 | 改写 prompt + 多轮 history 含完整 HTML 源码 | assistant 消息带上一版完整 `<html>...<script>...` | **403**（WAF） | 历史代码同样会触发 |
| 6 | 极小 system + user 消息内嵌一段 HTML | 只有 user 含标签 | **403**（WAF） | 与 system 无关，任何含标签的消息都会触发 |

网络事件原始记录：`waf-diagnose-1.json`（`network` 字段）、变体结果：`waf-diagnose-2-variants.json`。

## 结论（实测事实）

发布域前置的**腾讯云 WAF 对请求体里的 ASCII 尖括号 HTML 标签字面量做 XSS 判定**，命中即返回 403 拦截页。与模型、鉴权、请求路径、流式协议都无关。原本前后端共用的 `SYSTEM_PROMPT` 和「把上一版完整 HTML 作为 history 回传」这两个设计，在本地 Ollama / OpenAI 兼容通道完全正常，但在该 WAF 后面不可用。

## 修复（代码事实）

1. `public/shared.js`：`SYSTEM_PROMPT` 改为等价的自然语言表述，不再出现任何 `<...>` 字面量（如「所有 JavaScript 内联写在 script 元素内」「以标准 HTML5 文档声明开头，以 html 结束标签收尾」）。模型仍输出标准 HTML 文档，`extractHtml()` 逻辑不变。
2. `public/app.js`：新增 `cloudText()` 把 idea / diagnostics 中的尖括号换成单书名号；`summarizeHtml()` 把上一版应用转成不含尖括号的纯文本结构摘要（页面标题、标题文案、按钮文案、控件数量）。云端多轮对话改传该摘要，本地自托管仍回传完整源码。
3. 三条处理只作用于请求体；用户看到的输入原文、模型返回的 HTML、预览 iframe 与自检探针均不受影响。

## 取舍说明

云端多轮修改的上下文从「完整源码」降为「结构摘要」，是 WAF 约束下的真实能力折损，不掩饰：云端版本更接近「基于需求链重新生成」，本地自托管版本才是「基于当前代码增量修改」。这一差异已写入 `README.md` 与 `SUBMISSION.md`。

## 复跑

```bash
# 修复后线上完整验收（两轮真实云端生成 + 自检 + 多轮迭代）
BASE="https://wbapp-y5wxetvgn0wc7wvssf372f.app.workbuddy.host/?sharecode=SY54IO7FE7" \
CDP_PORT=9229 RESULTS_SUBDIR=online node tests/e2e_cdp.js
```

## 修复后验收结果

`e2e_result.json`（线上最终验收）与 `e2e_result.json`（本地回归）均为 `success: true`：
两轮真实模型生成、两轮自动自检通过、版本 v1/v2 产生、预览与导出可用，
`pageExceptions=[]`、`consoleErrors=[]`。修复有效，不是绕过报错。
