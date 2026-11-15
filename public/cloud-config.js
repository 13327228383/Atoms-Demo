'use strict';

/*
 * 由 WorkBuddy 云服务激活返回的 publicConfig 生成（不是手工猜测的域名）。
 * publishableKey 只是「标识这是哪个应用」的公开值，本身不带权限，
 * 服务端还会校验浏览器 Origin 必须与本应用的发布域名完全一致。
 *
 * 只有 LLM_PROVIDER=cloud 的部署环境才会用到它；本地 / 开源自托管默认走
 * Ollama 或 OpenAI 兼容通道，不加载云 SDK。重新激活应用时需同步更新此文件。
 */
window.__WB_PUBLIC_CONFIG__ = {
  resourceId: 'wbcs_4h44a4R7EUGkHnhuFIHOn4',
  endpoint: 'https://wbapp-y5wxetvgn0wc7wvssf372f.app.workbuddy.host',
  publishableKey: 'wbpk_Y5wxetvgn0wC7wVSsf372f_5ph0a4ldKZCVnUnz3T1iGf3ifBTsDQ4A'
};
