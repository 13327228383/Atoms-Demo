# Atoms Demo

一句话描述想法 → 智能体生成完整可运行的网页应用 → 页面内实时预览 → 继续用对话修改 → 导出源码。
生成完成后会在浏览器沙箱里**自动做一次真实冒烟自检**，失败时把诊断原文回灌给模型自动修复一次。

这是 DeepWisdom / ROOT 全栈岗位笔试的作业项目，与任何已有项目代码无关。

## 快速开始

零 npm 依赖，只需要 Node.js 18+：

```bash
node server.js
# 打开 http://127.0.0.1:8787
```

默认使用本机 Ollama 的 `qwen2.5:7b`，**无需注册、无需 API Key**。首次生成在本地 7B 模型上约 60–90 秒，界面会实时显示已生成的字符。

## 模型配置

复制 `.env.example` 为 `.env` 后按需填写（`.env` 已被 git 忽略，不要提交密钥）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` 或 `openai`（任意 OpenAI 兼容接口） |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | 本地 Ollama 地址 |
| `OLLAMA_MODEL` | `qwen2.5:7b` | 本地模型名 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 兼容接口地址 |
| `OPENAI_API_KEY` | 空 | 云端密钥，只从环境变量读取 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 云端模型名 |
| `PORT` | `8787` | 服务端口 |

切到云端模型可显著提速并提升生成质量：

```bash
LLM_PROVIDER=openai OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... node server.js
```

首页右上角会**真实探测**模型是否在线；离线时生成会如实报错，不会返回伪造结果。

## 功能

- **核心主流程**：自然语言输入 → SSE 流式展示生成过程 → `iframe sandbox` 实时渲染 → 多轮对话基于当前代码迭代 → 版本历史切换 → 查看完整源码 / 复制 / 下载 `.html`。
- **延展能力（自动冒烟自检闭环）**：探针注入预览 iframe，真实捕获未捕获异常与 `console.error`、统计 DOM 渲染、清点可交互控件、给空文本框填测试值后真实点击最多 3 个按钮并比对点击前后的可见变化、检查外链资源。失败项原文回灌模型自动重生成一次；探针超时不会被算作通过。
- **无需注册**：打开即用，无登录、无数据库、无外部依赖。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /api/config` | 当前 provider / 模型 / 在线状态（不返回密钥） |
| `POST /api/generate` | SSE 流式生成，事件类型 `status` / `delta` / `done` / `error` |

## 目录

```
server.js            零依赖 HTTP 服务、静态托管、SSE 生成接口
lib/llm.js           Ollama / OpenAI 兼容双通道、提示词、HTML 抽取与校验
public/index.html    单页界面
public/app.css       界面样式
public/app.js        对话、流式渲染、预览、版本、自检回灌、导出
public/probe.js      注入 iframe 的真实自检探针
tests/e2e_cdp.js     真实浏览器端到端验证（CDP，真实键盘/鼠标事件）
tests/probe_quick.js 探针快速自测（不调模型）
tests/results/       验证证据：JSON + 截图
SUBMISSION.md        笔试说明文档（实现思路 / 完成程度 / 扩展优先级）
```

## 复跑验证

```bash
# 先启动服务，再开一个带 CDP 的 Chromium（端口 9223），或用已运行的实例
node tests/probe_quick.js     # 只验证探针，约 2 秒
node tests/e2e_cdp.js         # 真实 UI 全流程，含两轮真实模型生成，约 3–5 分钟
```

`e2e_cdp.js` 通过 Chrome DevTools Protocol 驱动真实 Chromium：聚焦输入框 → 键盘输入 → 鼠标点击 → 等待真实模型生成 → 读取自检报告与预览 iframe → 验证代码页与导出控件 → 再走一轮多轮修改。它**不直接调用后端生成接口**。证据落在 `tests/results/`。

## 公网部署

服务已按单端口 HTTP 应用设计：监听 `PORT` 环境变量、绑定 `0.0.0.0`、零外部依赖、无数据库，可直接跑在任意 Node 平台或 WorkBuddy「发布为应用」的沙箱里。

**关键前提：部署环境必须能访问一个真实模型。** 沙箱里没有本机的 Ollama；若不配置模型通道，线上点「生成」会如实报错，而不是返回伪造结果。三选一：

```bash
# A（推荐）：任意 OpenAI 兼容接口，速度快、质量高
LLM_PROVIDER=openai OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... node server.js

# B：平台提供的免密钥 LLM —— 在 lib/llm.js 增加对应 provider 分支
# C：让部署端可访问带访问控制的 Ollama 服务（不要把 11434 裸奔到公网）
```

密钥只从进程环境变量读取，绝不写入仓库。部署后验收：`GET /health` 返回 200 → 页面里真实生成一次 → 确认自检报告出现。

## 已知限制（如实标注）

- 生成物被刻意限定为**单文件 HTML**：不做后端、数据库、构建系统，因此不能生成真正的全栈应用。
- 本地 `qwen2.5:7b` 生成偏慢且代码质量一般；模型输出若无法抽取出完整 HTML 会**如实报错**，不补造代码。
- 预览 iframe 使用 `sandbox="allow-scripts"`（不开放 `allow-same-origin`），不透明源下 `localStorage` 会抛异常，探针提供**内存垫片**并在报告里显式标注；导出的 HTML 不含垫片，在普通页面里使用原生 `localStorage`。
- 自检是冒烟级：最多点 3 个按钮，跳过 form 内的 submit 与删除/清空/重置等破坏性按钮，不覆盖跨页面流程、网络请求与视觉回归。
- 失败只自动重生成一次，避免无限循环消耗算力。
- 公网部署需要自行提供模型：要么部署端可访问 Ollama，要么注入 OpenAI 兼容的 `OPENAI_*` 环境变量。
