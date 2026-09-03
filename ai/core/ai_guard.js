// ai_guard.js —— 反编造 guard 的**纯判定**（不碰 DOM、不碰 chrome，方便 docs/verify-free-first.mjs 直接断言）
// 口径来源：docs/plan-桥接关闭时对话体验.md §1-R3/§2-M3。
// 旧版只有「成功取数 / 没查」两态，且命中只看**名词**（收盘、涨跌幅…），
// 于是「解释为什么拿不到数据」的天然措辞必被误杀 —— 本文件把三态与数值形态写在一处。

// guard 与跨轮账本共用的「有真实数据来源」口径：行情接口 + 会带回库存价格/SQL 行的工具
export const QUOTE_TOOLS = new Set([
    'get_stock_quote', 'get_portfolio_quotes', 'read_stock_kline', 'read_stocks_kline',
    'get_stock_list', 'query_local_database',
]);

// 行情名词（只当语境，不再单独构成编造证据）
const QUOTE_WORDS = /(现价|收盘|开盘|最高|最低|涨跌幅|涨跌额|成交量|成交额|换手率|跌停|涨停|股价|价格|市值)/;
// 价格形态的数字：小数（34.16 / 1.2亿）、百分数（3.2%）、带符号涨跌（-5.01）
const PRICE_NUMBER = /\d+\.\d+|\d+\s*%|[+\-]\d+(?:\.\d+)?(?=\s*%)/;
// 带数字的 markdown 表格行（| 600206 | 12.3 | ...），文件清单这类要靠「行情话题」再加一道闸
const NUMERIC_TABLE_ROW = /^\s*\|.*\|\s*[-+]?\d[\d.,]*\s*\|/m;

/** 剥掉不该被当价格的数字形态：日期/时间、股票代码、URL（避免 2026-09-02、002940.SZ 触发判定） */
function stripLookAlikeNumbers(text) {
    return String(text || '')
        .replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g, ' ')
        .replace(/\b\d{6}(?:\.(?:SZ|SH|BJ))?\b/gi, ' ')
        .replace(/\b(?:SH|SZ|BJ)\d{6}\b/gi, ' ')
        .replace(/https?:\/\/\S+/g, ' ');
}

/**
 * 正文像不像「凭空给出的行情数值」。
 * 返回 { hit, strong, why }：strong=有价格名词 + 价格数字（旧版会丢弃正文的强信号）；
 * 仅「表格 + 行情话题」为弱信号（放行加免责，避免误伤文件清单/列表名）。
 */
export function quoteFabricationSignal(text, topicIsQuote = false) {
    const raw = String(text || '');
    if (!raw.trim()) return { hit: false, strong: false, why: '空正文' };
    const t = stripLookAlikeNumbers(raw);
    const words = QUOTE_WORDS.test(raw);
    const numbers = PRICE_NUMBER.test(t);
    const numericTable = NUMERIC_TABLE_ROW.test(raw);
    if (words && numbers) return { hit: true, strong: true, why: '行情名词 + 价格形态数值' };
    if (numericTable && topicIsQuote) return { hit: true, strong: false, why: '带数字的表格 + 行情话题' };
    return { hit: false, strong: false, why: numbers ? '有数字但无行情语境（不算编造）' : '无价格形态数值' };
}

/**
 * 工具返回是不是「终局拒绝」：拿回了 error，同时带了 取数诊断/本地库诊断/渠道诊断/排查/hint 之一
 * —— 说明工具确实查过并给出了原因（不是抛异常、不是没查），此时解释型回复是系统提示要求的答案。
 * 入参为 JSON.parse 后的对象（或 null）。
 */
export function isTerminalRefusal(payload) {
    const p = payload && typeof payload === 'object' ? payload : null;
    if (!p || typeof p.error !== 'string' || !p.error) return false;
    return !!(p['取数诊断'] || p['本地库诊断'] || p['渠道诊断'] || p['排查'] || p.hint);
}

/**
 * guard 决策（纯函数）。入参：
 * - text：本轮助手正文
 * - topicIsQuote：话题是否接着行情问的（quoteTopicNearby 的结果）
 * - refusal：本轮行情工具是否「终局拒绝」（isTerminalRefusal 得出）
 * - retried：是否已经注入过一次强制纠正
 * 返回 action：
 * - 'pass'       正常提交正文
 * - 'note'       提交正文 + 一行灰字说明（工具明确拒绝后的原因转述）
 * - 'correct'    注入强制纠正，再来一轮
 * - 'pass_warn'  提交正文 + 一行「数值无来源请核对」（弱信号二次命中）
 * - 'drop'       丢弃正文并报错
 */
export function decideQuoteGuard({ text = '', topicIsQuote = false, refusal = false, retried = false } = {}) {
    const sig = quoteFabricationSignal(text, topicIsQuote);
    if (!sig.hit) {
        return refusal
            ? { action: 'note', ...sig, why: '工具已明确拒绝，正文为不可用原因的转述' }
            : { action: 'pass', ...sig };
    }
    // 本轮工具已经说过「拿不到数据」：任何价格数值都没有来源，且重查必然还是同一个拒绝 → 不再白烧一次往返
    if (refusal) return { action: 'drop', ...sig, why: '工具本轮已终局拒绝，正文仍给出行情数值' };
    if (!retried) return { action: 'correct', ...sig };
    return sig.strong
        ? { action: 'drop', ...sig, why: '强制纠正后仍给出行情数值' }
        : { action: 'pass_warn', ...sig, why: '弱信号（表格数字 + 行情话题），放行并提示核对' };
}

/** 强制纠正正文（M4：不命令「必须再调一次工具」，而是教它把已知的拒绝原因讲清楚） */
export function correctionPromptText() {
    return '【强制纠正】本轮没有任何取数成功的工具调用（上一轮工具记录也未显示行情数据），刚才那段数字是编造的，不可使用。'
        + '输出行情信息（价格/涨跌幅/成交量/K 线表格等）必须以本轮成功取数的工具调用为前提：本轮没有成功调用行情工具时，正文里不得出现任何行情数值，要么先重新调用工具取数，要么直接告诉用户没取到。'
        + '若确实需要数据：只能用本轮或工具记录里出现过的股票代码，拿不准就传股票名称（name / names），行情工具内部会自己解析代码。'
        + '如果工具已经明确返回了不可用原因，**照原样转述该原因并给出可行替代**就是正确答案，不要重复调用同一工具、不要凭记忆补数字。'
        + '拿不到时不得输出任何价格、涨跌幅、成交量或 K 线表格——说「没有取到数据」比编一个数好。'
        + '后面还要用的数据，取到后本轮调 retain_tool_data 登记成隐藏便签（tool 原始返回下一轮就不在你的上下文里了）。';
}
