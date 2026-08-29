import { extractCodePrefixFromDot, parseXqStockName, cleanNumberText } from '../shared/utils.js';

// 从 html 文档按选择器取文本（支持 #id 与 css 选择器）
export function getTargetData(doc, selector) {
    const el = selector.startsWith('#')
        ? doc.getElementById(selector.substring(1))
        : doc.querySelector(selector);
    return el ? el.textContent : null;
}

// 问财解析：名称去括号，code/prefix 从 .code 文本正则提取
export function parseWc1(doc, selector) {
    let name = getTargetData(doc, selector.name);
    if (!name) return null;
    name = name.substring(0, name.indexOf('('));
    const { code, prefix } = extractCodePrefixFromDot(getTargetData(doc, selector.code));
    const dqj = parseFloat(getTargetData(doc, selector.dqj));
    const zdf = parseFloat(getTargetData(doc, selector.zdf));
    let percent = getTargetData(doc, selector.percent);
    percent = percent ? parseFloat(percent.replace('%', '').replace('/', '')) : null;
    if (isNaN(percent)) percent = null;
    let lastClose = null;
    if (!isNaN(dqj) && !isNaN(zdf)) {
        const zsp = (dqj - zdf).toFixed(2);
        if (zsp !== 'NaN') lastClose = zsp;
    }
    return { name, code, prefix, currentPrice: isNaN(dqj) ? null : dqj, percent, lastClose };
}

// 雪球解析：名称/代码/前缀来自 .stock-name，涨跌额与涨跌幅同处 .stock-change
export function parseXq1(doc, selector) {
    const parsed = parseXqStockName(getTargetData(doc, selector.name));
    if (!parsed) return null;
    const cur = parseFloat(cleanNumberText(getTargetData(doc, selector.dqj)));
    const parts = (getTargetData(doc, selector.zdf) || '').trim().split(/\s+/);
    const zdf = parseFloat(cleanNumberText(parts[0]));
    let percent = parts[1] != null ? parseFloat(cleanNumberText(parts[1])) : NaN;
    if (isNaN(percent)) percent = null;
    const currentPrice = isNaN(cur) ? null : cur;
    let lastClose = null;
    if (currentPrice != null && !isNaN(zdf)) lastClose = (currentPrice - zdf).toFixed(2);
    return { name: parsed.name, code: parsed.code, prefix: parsed.prefix, currentPrice, percent, lastClose };
}
