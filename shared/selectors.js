// 抓取规则表：按页面域名派发（wc1 问财结果页 / xq1 雪球个股页），与下拉选择器无关。
// 支持新版式 = 在此加一组枚举；解析实现在 popup/parsers.js，由 offscreen 隐藏页调用
// （Service Worker 无 DOM，DOMParser 相关解析须在页面环境执行）。
export const selectorsEnum = {
    "wc1": { // 同花顺问财
        name: ".code-info-bar .code-name",
        code: ".diagnosisList .code",
        dqj: ".code-info-bar .price",
        zdf: ".code-info-bar .rise-fall",
        percent: ".code-info-bar .rise-fall-rate"
    },
    "xq1": { // 雪球个股页
        name: ".stock-name",
        dqj: ".stock-price .stock-current",
        zdf: ".stock-price .stock-change"
    }
};
