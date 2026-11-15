# Atoms Demo

一句话描述想法 → 智能体生成完整可运行的网页应用 → 页面内实时预览 → 继续用对话修改 → 导出源码。
生成完成后会在浏览器沙箱里**自动做一次真实冒烟自检**，失败时把诊断原文回灌给模型自动修复一次。

这是 DeepWisdom / ROOT「AI Native 全栈工程师」岗位笔试的作业项目，与任何已有项目代码无关。MIT 开源。

| 交付项 | 链接 |
|---|---|
| 在线可测试 Demo | https://wbapp-y5wxetvgn0wc7wvssf372f.app.workbuddy.host/?sharecode=SY54IO7FE7 |
| GitHub 源码 | https://github.com/13327228383/Atoms-Demo |

> 打开在线 Demo 请使用**完整链接（含 `?sharecode=`）**：发布网关依赖该参数放行，裸域名会被判为「链接不完整」。

## 快速开始

零 npm 依赖，只需要 Node.js 18+：

```bash
node server.js
# 打开 http://127.0.0.1:8787
```

默认使用本机 Ollama 的 `qwen2.5:7b`，**无需注册、无需 API Key**。首次生成在本地 7B 模型上约 1 分钟量级（人工观察值，随机器与模型波动），界面会实时显示已生成的字符。

## 模型配置

复制 `.env.example` 为 `.env` 后按需填写（`.env` 已被 git 忽略，不要提交密钥）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` / `openai`（任意 OpenAI 兼容接口）/ `cloud`（平台免密钥 LLM） |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | 本地 Ollama 地址 |
| `OLLAMA_MODEL` | `qwen2.5:7b` | 本地模型名 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 兼容接口地址 |
| `OPENAI_API_KEY` | 空 | 云端密钥，只从环境变量读取 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 云端模型名 |
| `PORT` | `8787` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

切到云端模型可显著提速并提升生成质量：

```bash
LLM_PROVIDER=openai OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... node server.js
```

首页右上角会**真实探测**模型是否在线；离线时生成会如实报错，不会返回伪造结果。

### 三种 provider 的区别

| provider | 模型调用位置 | 适用场景 |
|---|---|---|
| `ollama` | 服务端 → 本机 Ollama | 本地开发、离线复现 |
| `openai` | 服务端 → OpenAI 兼容接口 | 自托管上公网，密钥只在服务端 |
| `cloud` | **浏览器端 SDK 直连**平台免密钥 LLM | 本次在线 Demo 使用，无需自备 Key |

`cloud` 模式下服务端**不做 BFF 转发**（云服务禁止服务端代理），`/api/generate` 会明确返回 400；生成契约（system prompt、构建 messages、HTML 抽取）由 `public/shared.js` 前后端共用，避免两条通道的提示词漂移。

`public/cloud-config.js` 里的 `publishableKey` 是**公开的应用标识**，不是密钥：服务端还会校验浏览器 Origin 必须与绑定域名完全一致。它只对本次部署的域名生效；自托管请用 `ollama` 或 `openai`，不需要这个文件。`public/vendor/workbuddy-cloud-sdk.js` 是 SDK 的 IIFE 构建，同源托管以避免 CDN 不可达导致线上打开就失败。

## 功能

- **核心主流程**：自然语言输入 → SSE / SDK 流式展示生成过程 → `iframe sandbox` 实时渲染 → 多轮对话迭代 → 版本历史切换 → 查看完整源码 / 复制 / 下载 `.html`。
  本地自托管模式把上一版**完整源码**回传模型做增量修改；云端模式因发布域 WAF 会拦截请求体里的 HTML 标签字面量，改传等价的**纯文本结构摘要**，详见 `tests/results/online/WAF_ROOTCAUSE.md`。
- **延展能力（自动冒烟自检闭环）**：探针注入预览 iframe，真实捕获未捕获异常与 `console.error`、统计 DOM 渲染、清点可交互控件、给空文本框填测试值后真实点击最多 3 个按钮并比对点击前后的可见变化、检查外链资源。失败项原文回灌模型自动重生成一次；探针超时不会被算作通过。
- **无需注册**：打开即用，无登录、无数据库、无外部依赖。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /health` | 健康检查（返回 provider 与模型标签） |
| `GET /api/config` | 当前 provider / 模型 / 在线状态（不返回密钥） |
| `POST /api/generate` | SSE 流式生成，事件类型 `status` / `delta` / `done` / `error`；`cloud` 模式返回 400 |

## 目录

```
server.js                      零依赖 HTTP 服务、静态托管、SSE 生成接口
lib/llm.js                     Ollama / OpenAI 兼容双通道、流式调用、模型探测
public/index.html              单页界面
public/app.css                 界面样式
public/app.js                  对话、流式渲染、预览、版本、自检回灌、cloud SDK 接入
public/probe.js                注入 iframe 的真实自检探针
public/shared.js               前后端共用的生成契约（UMD）
public/cloud-config.js         部署实例的公开配置（endpoint / publishableKey）
public/vendor/                 同源托管的 cloud SDK IIFE 构建
tests/e2e_cdp.js               真实浏览器端到端验证（CDP，真实键盘/鼠标事件）
tests/probe_quick.js           探针快速自测（不调模型）
tests/results/                 本地验证证据：JSON + 截图
tests/results/online/          线上验证证据：JSON + 截图
SUBMISSION.md                  笔试说明文档（实现思路 / 完成程度 / 扩展优先级）
FEISHU_COPY.md                 可直接粘贴进飞书文档副本的提交稿
```

## 复跑验证

```bash
# 先启动服务，再开一个带 CDP 的 Chromium（默认复用 9223 端口，脚本可自行拉起）
node tests/probe_quick.js     # 只验证探针，秒级
node tests/e2e_cdp.js         # 真实 UI 全流程，含两轮真实模型生成，数分钟量级

# 针对线上部署复跑（带 sharecode 的完整链接）
BASE="https://wbapp-y5wxetvgn0wc7wvssf372f.app.workbuddy.host/?sharecode=SY54IO7FE7" \
CDP_PORT=9229 RESULTS_SUBDIR=online node tests/e2e_cdp.js
```

`e2e_cdp.js` 通过 Chrome DevTools Protocol 驱动真实 Chromium：聚焦输入框 → 键盘输入 → 鼠标点击 → 等待真实模型生成 → 读取自检报告与预览 iframe → 验证代码页与导出控件 → 再走一轮多轮修改。它**不直接调用后端生成接口**，也不依赖 Playwright。证据落在 `tests/results/`。

> 结果 JSON 中生成字符数、自检项、`pageExceptions` / `consoleErrors` / `success` 均为结构化字段；`startedAt` / `durationMs` / `durationHuman` 记录脚本真实墙钟耗时，复跑自动产出。本仓库归档的早期结果生成于该耗时字段加入之前，不含耗时字段，不回填、不补造数字。

## 公网部署

服务已按单端口 HTTP 应用设计：监听 `PORT` 环境变量、绑定 `0.0.0.0`、零外部依赖、无数据库。本次在线 Demo 通过 WorkBuddy「发布为应用」部署，并设置 `LLM_PROVIDER=cloud`。

**关键前提：部署环境必须能访问一个真实模型。** 沙箱里没有本机的 Ollama；若不配置模型通道，线上点「生成」会如实报错，而不是返回伪造结果。三选一：

```bash
# A：任意 OpenAI 兼容接口，速度快、质量高
LLM_PROVIDER=openai OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... node server.js

# B：平台免密钥 LLM，浏览器端 SDK 直连（本次在线 Demo 采用）
LLM_PROVIDER=cloud node server.js

# C：让部署端可访问带访问控制的 Ollama 服务（不要把 11434 裸奔到公网）
```

密钥只从进程环境变量读取，绝不写入仓库。部署后验收：`GET /health` 返回 200 → 页面里真实生成一次 → 确认自检报告出现。

> 补充说明：GitHub Pages 只能托管静态资源，**不能运行这个 Node HTTP 服务**。所以 GitHub 用于公开源码，在线 Demo 另由支持单端口 HTTP 应用的平台托管；两者都是免费的。

## 已知限制（如实标注）

- 生成物被刻意限定为**单文件 HTML**：不做后端、数据库、构建系统，因此不能生成真正的全栈应用。
- 本地 `qwen2.5:7b` 生成偏慢且代码质量一般；模型输出若无法抽取出完整 HTML 会**如实报错**，不补造代码。
- 预览 iframe 使用 `sandbox="allow-scripts"`（不开放 `allow-same-origin`），不透明源下 `localStorage` 会抛异常，探针提供**内存垫片**并在报告里显式标注；导出的 HTML 不含垫片，在普通页面里使用原生 `localStorage`。
- 自检是冒烟级：最多点 3 个按钮，跳过 form 内的 submit 与删除/清空/重置等破坏性按钮，不覆盖跨页面流程、网络请求与视觉回归。
- 失败只自动重生成一次，避免无限循环消耗算力。
- `cloud` 模式的模型目录由平台提供，会随平台调整；界面优先选用免费/快速模型，目录为空时如实报错，不硬编码兜底模型。
- `cloud` 模式的多轮上下文是结构摘要而非完整源码，因此第二版更接近「按需求链重新生成」，不保证与第一版视觉/结构完全一致；本地自托管模式没有这个限制。这是发布域 WAF 约束下的取舍，不是功能缺失的掩饰。
