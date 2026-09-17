// ai_guard.js —— 反编造 guard 的**纯判定**（不碰 DOM、不碰 chrome，方便 scripts/verify/verify-free-first.mjs 直接断言）
// 口径来源：docs/archive/2026-09-plans/plan-桥接关闭时对话体验.md §1-R3/§2-M3。
// 旧版只有「成功取数 / 没查」两态，且命中只看**名词**（收盘、涨跌幅…），
// 于是「解释为什么拿不到数据」的天然措辞必被误杀 —— 本文件把三态与数值形态写在一处。
// 2026-09-16 维度修复（docs/incidents/2026-09-16-guard-历史证据维度误判导致幻觉漏拦截.md）：
//   行情工具按「数据维度」分快照 / K 线两类。历史证据验证必须与话题维度匹配，
//   否则上一轮取到的「实时报价」会被当成「K 线历史」的证据，guard 整体短路放行——
//   debug.txt [043] 无工具调用却输出 1111 字编造 K 线的根因。

// guard 与跨轮账本共用的「有真实数据来源」口径：行情接口 + 会带回库存价格/SQL 行的工具
// 快照类：一次现价/报价（get_stock_quote / get_portfolio_quotes）——不能支撑 K 线历史分析
// K 线类：一段历史日线/OHLCV/派生指标（read_stock_kline / read_stocks_kline）
export const SNAPSHOT_QUOTE_TOOLS = new Set(['get_stock_quote', 'get_portfolio_quotes']);
export const KLINE_QUOTE_TOOLS = new Set(['read_stock_kline', 'read_stocks_kline']);
export const QUOTE_TOOLS = new Set([
    ...SNAPSHOT_QUOTE_TOOLS,
    ...KLINE_QUOTE_TOOLS,
    'get_stock_list', 'query_local_database',
]);

// 行情名词（只当语境，不再单独构成编造证据）
const QUOTE_WORDS = /(现价|收盘|开盘|最高|最低|涨跌幅|涨跌额|成交量|成交额|换手率|跌停|涨停|股价|价格|市值)/;
// 价格形态的数字：小数（34.16 / 1.2亿）、百分数（3.2%）、带符号涨跌（-5.01）
const PRICE_NUMBER = /\d+\.\d+|\d+\s*%|[+\-]\d+(?:\.\d+)?(?=\s*%)/;

// 话题明确要求「K 线 / 日线 / 技术分析」维度的词。命中后只有 K 线类取数（read_stock_kline /
// read_stocks_kline）的成功记录才算证据，实时报价不算（docs/incidents/2026-09-16-guard-历史证据维度误判导致幻觉漏拦截.md）。
// 有意收窄：不带「走势 / 形态 / 20日 / 30日」这类可能是口语宽泛表达的词，避免误触发强制取数。
export const KLINE_TOPIC_RE = /(K\s*线|日k|日线|技术分析|均线|MACD|KDJ|MA5|MA10|MA20|复盘|K线图|蜡烛图)/i;
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

/**
 * guard 是否入场判定（纯函数，可被回归脚本直接测，G4 断言）。
 * 没有任何行情上下文时的正文（话题非行情、本轮也没调用/拒绝过行情工具）里的行情名词/数字
 * 几乎必然是「复述用户消息或读到的文件」，不是凭空编造——此时必须放行，
 * 否则正常问答（读 FACT.md、复述用户卖出价）会被强制取数（debug.txt [052][056]、[023]）。
 * @param {boolean} topicIsQuote 话题是否行情（quoteTopicNearby 只扫 user 的结果）
 * @param {boolean} quoteCalled   本轮是否调用过行情工具（含成功与失败）
 * @param {boolean} quoteRefused  本轮行情工具是否终局拒绝
 */
export function shouldJudgeQuote({ topicIsQuote = false, quoteCalled = false, quoteRefused = false } = {}) {
    return topicIsQuote || quoteCalled || quoteRefused;
}

// content 可能是字符串或 OpenAI 多模态 parts 数组；只取可判别的文本（图片只留占位，不算话题词）
function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(p => {
            if (p == null) return '';
            if (typeof p === 'string') return p;
            if (p.type === 'text') return p.text || '';
            return ' [img] ';
        }).join(' ');
    }
    return '';
}

/**
 * 最近几条「用户」消息里是否有话题词（纯函数，可被回归脚本直接测，G4 断言）。
 * **只扫 role='user'，不扫 assistant**——模型回复里自然带出的行情词（如「查行情/查K线」）
 * 不属于用户意图；若把模型自述算进话题，后续每一轮都会被误判成行情话题，guard 就会
 * 把读文件/复述用户数据的正文当编造强制取数（debug.txt [052][056]、[023]，bug2 根因）。
 * 用户连续追问（如只回「好的」）时关键词仍在历史 user 消息里，向上找即可。
 * @param {Array} apiMessages 发给模型的 API 消息（带 kind 隐藏标记）
 * @param {RegExp} re 话题词正则
 * @param {number} maxUsers 最多回看几条用户消息
 */
export function recentUserTopic(apiMessages, re, maxUsers = 4) {
    let users = 0;
    for (let i = (apiMessages || []).length - 1; i >= 0; i--) {
        const m = apiMessages[i];
        if (!m || m.kind === 'tool_trace' || m.kind === 'retained_data' || m.kind === 'compact_note') continue; // 隐藏条目自带行情字样，不能当话题证据
        if (m.role !== 'user') continue;
        const text = contentToText(m.content);
        if (text && re.test(text)) return true;
        if (++users >= maxUsers) break;
    }
    return false;
}

/**
 * 历史证据验证（纯函数，可被回归脚本直接测）：检查隐藏条目（tool_trace 账本 / retained_data 便签）
 * 里是否有「与话题所需数据维度匹配」的真实行情来源。ai.js 的 hasPriorQuoteEvidence 委托给它。
 * klineNeeded=true 时只认 K 线类工具（read_stock_kline / read_stocks_kline）的证据——
 * 上一轮取到的实时报价不能充当 K 线分析的证据（docs/incidents/2026-09-16-guard-历史证据维度误判导致幻觉漏拦截.md）。
 * @param {Array} entries 隐藏条目数组（{ kind: 'tool_trace'|'retained_data', source?, calls? }）
 * @param {boolean} klineNeeded 话题是否明确要求 K 线/日线/技术分析维度
 */
export function hasQuoteEvidence(entries, klineNeeded = false) {
    const tools = klineNeeded ? KLINE_QUOTE_TOOLS : QUOTE_TOOLS;
    return (entries || []).some(m =>
        (m.kind === 'retained_data' && tools.has(m.source))
        || (m.kind === 'tool_trace' && (m.calls || []).some(c => tools.has(c.name) && c.ok === true)));
}
