// offscreen.js —— 隐藏解析页：Service Worker 无 DOM，DOMParser 相关解析在此执行。
// background 收到页面抓取后发 parseDocument 消息，本页解析并同步回传结果。
// 生命周期：由 background/landing.js 按需创建，常驻不销毁（隐藏页开销极小）。

import { selectorsEnum } from '../shared/selectors.js';
import { parseWc1, parseXq1 } from '../popup/parsers.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'parseDocument') return; // 其他消息不响应（同步忽略）
    const selector = selectorsEnum[msg.key];
    if (!selector || !msg.html) {
        sendResponse({ error: '无效的解析请求' });
        return;
    }
    try {
        const doc = new DOMParser().parseFromString(msg.html, 'text/html');
        // 解析规则按抓取页域名派发（key 由 background 按 selectorKeyForUrl 预先算好）
        const parsed = msg.key === 'wc1' ? parseWc1(doc, selector) : parseXq1(doc, selector);
        sendResponse({ parsed });
    } catch (err) {
        sendResponse({ error: (err && err.message) || String(err) });
    }
});
