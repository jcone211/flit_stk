/**
 * 实时股价获取模块（adata 数据源，扩展内 ES module 版）
 *
 * 从 adata(Python) 移植:adata/stock/market/stock_market/ 中的 list_market_current
 *   - stock_market_sina.py (新浪,主源)
 *   - stock_market_qq.py   (腾讯,回退源)
 *   - common/utils/code_utils.py (股票代码 -> 交易所)
 * 保持与 Python 版相同的解析逻辑、单位换算与输出字段。
 *
 * 注意:新浪接口要求 Referer 头,浏览器无法跨域设置该头,故浏览器环境会回退到腾讯。
 *     腾讯接口为公开免费行情,无需 API Key。
 * 本模块已改为 ES module,Chrome 扩展(MV3)与 Node.js 18+ 均可直接 import;
 * 命令行自测用 import.meta.main 判断（Node 22.13+）。
 *
 * 统一出口 batchQuotes(codes, opts) 与小石 xiaoshi_realtime_quote.js 签名一致,
 * 输出字段归一为 { code, name, price, change, change_pct, last_close, ... }。
 */

'use strict';

// 股票代码前缀 -> 交易所 (对应 code_utils.py 的 exchange_suffix)
const EXCHANGE_SUFFIX = {
  '00': 'SZ', '20': 'SZ', '30': 'SZ', '15': 'SZ',
  '43': 'BJ', '83': 'BJ', '87': 'BJ', '92': 'BJ',
  '60': 'SH', '68': 'SH', '90': 'SH',
  // 沪市基金：51/58 为 ETF（与 shared/utils.js etfPrefixForCode 对齐），56 为 ETF 新段，50 为 LOF/封基
  '50': 'SH', '51': 'SH', '56': 'SH', '58': 'SH',
};

/** 根据股票代码前缀获取交易所 (对应 get_exchange_by_stock_code) */
export function getExchangeByStockCode(stockCode) {
  return EXCHANGE_SUFFIX[String(stockCode).slice(0, 2)] || '';
}

/** 新浪请求头 (对应 common/headers/sina_headers.py 的 c_headers) */
const SINA_HEADERS = {
  Host: 'hq.sinajs.cn',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/110.0',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
  Referer: 'http://vip.stock.finance.sina.com.cn/',
};

/**
 * 读取响应并按其 Content-Type 声明的 charset 解码。
 * 新浪接口返回 GBK/GB2312,而 res.text() 始终按 UTF-8 解码,会导致中文乱码。
 * Python 版 requests.text 会自动识别 charset,这里做等价处理。
 */
async function decodeResponse(res) {
  const buf = await res.arrayBuffer();
  const charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || 'utf-8';
  const enc = /^gbk$/i.test(charset) || /^gb2312$/i.test(charset) || /^gb18030$/i.test(charset) ? 'gbk' : 'utf-8';
  return new TextDecoder(enc).decode(buf);
}

/**
 * 单位换算:沪深 A 股(代码以 0/3/6/9 开头) volume 为手(×100 -> 股),
 * amount 为万元(×10000 -> 元);北交所(4/8 开头)不做换算。
 * 与 Python 版 startswith(('0','3','6','9')) 逻辑一致。
 */
function convertUnits(rows) {
  for (const row of rows) {
    if (/^[0369]/.test(row.stock_code)) {
      row.volume *= 100;
      row.amount *= 10000;
    }
  }
  return rows;
}

/**
 * 新浪实时行情
 * url: https://hq.sinajs.cn/list=s_sh600905,s_sz000725,...
 * 返回:var hq_str_s_bj872925="平安银行,14.840,0.480,3.343,374847,5483780.180";
 * 注:浏览器环境无法设置 Referer,新浪大概率失败,由 listMarketCurrent 回退腾讯。
 */
export async function listMarketCurrentSina(codeList) {
  const query = codeList
    .map((code) => 's_' + getExchangeByStockCode(code).toLowerCase() + code)
    .join(',');
  const res = await fetch('https://hq.sinajs.cn/list=' + query, { headers: SINA_HEADERS });
  if (!res.ok) return [];
  const text = await decodeResponse(res);

  const rows = [];
  for (const dataStr of text.split(';')) {
    if (dataStr.length < 8) continue;
    const idx = dataStr.indexOf('=');
    const stockCode = dataStr.slice(idx - 6, idx); // 去掉 sh/sz/bj 前缀,取 6 位代码
    const fields = dataStr.slice(idx + 2, -1).split(','); // 跳过 =" 与结尾 "
    if (fields.length !== 6) continue;
    rows.push({
      stock_code: stockCode,
      short_name: fields[0],
      price: parseFloat(fields[1]),
      change: parseFloat(fields[2]),
      change_pct: parseFloat(fields[3]),
      volume: parseInt(fields[4], 10),
      amount: parseFloat(fields[5]),
    });
  }
  return convertUnits(rows);
}

/**
 * 腾讯实时行情(回退源)
 * url: https://qt.gtimg.cn/r=0.5979076524724433&q=s_sh600011,...
 * 返回:v_s_sz000936="51~华西股份~000936~12.60~1.15~10.04~69137~8711~~111.64~GP-A";
 * 字段按 ~ 分隔,取 [1:8]:short_name, stock_code, price, change, change_pct, volume(手), amount(万元)
 * 注:当前接口返回的每条末尾是 ~",即 GP-A 后还有一个 ~,
 *    与 Python 版注释中的格式(GP-A" 无尾 ~)不同,故先去掉结尾引号再拆分,兼容两种格式。
 */
export async function listMarketCurrentQQ(codeList) {
  const query = codeList
    .map((code) => 's_' + getExchangeByStockCode(code).toLowerCase() + code)
    .join(',');
  // r= 为随机参数,避免缓存
  const res = await fetch('https://qt.gtimg.cn/r=' + Math.random() + '&q=' + query);
  if (!res.ok) return [];
  const text = await decodeResponse(res);

  const rows = [];
  for (const dataStr of text.split(';')) {
    if (dataStr.length < 8) continue;
    const fields = dataStr.slice(0, -1).split('~'); // 去掉结尾 " 后再按 ~ 拆
    if (fields.length < 11) continue;
    rows.push({
      short_name: fields[1],
      stock_code: fields[2],
      price: parseFloat(fields[3]),
      change: parseFloat(fields[4]),
      change_pct: parseFloat(fields[5]),
      volume: parseInt(fields[6], 10),
      amount: parseFloat(fields[7]),
    });
  }
  return convertUnits(rows);
}

/**
 * 获取多个股票最新行情(优先新浪,为空/失败回退腾讯)
 * @param {string[]} codeList 股票代码列表,如 ['000001', '600001', '000795', '872925']
 * @returns {Promise<Array<{stock_code, short_name, price, change, change_pct, volume, amount}>>}
 */
export async function listMarketCurrent(codeList) {
  if (!codeList || !codeList.length) return [];
  const sina = await listMarketCurrentSina(codeList);
  if (sina.length) return sina;
  return listMarketCurrentQQ(codeList);
}

/**
 * 新浪全字段实时行情(主源)
 * url: https://hq.sinajs.cn/list=sh600519,sz000001   注意:不加 s_ 前缀才是全字段
 * 返回字段索引:0 名称 1 今开 2 昨收 3 最新价 4 最高 5 最低 8 成交量(股) 9 成交额(元) 30 日期 31 时间
 * 浏览器扩展页无法设置 Referer(禁止头),新浪常被 CORS 拦下,由 listMarketFull 回退腾讯
 */
export async function listMarketFullSina(codeList) {
  const query = codeList
    .map((code) => getExchangeByStockCode(code).toLowerCase() + code)
    .join(',');
  const res = await fetch('https://hq.sinajs.cn/list=' + query, { headers: SINA_HEADERS });
  if (!res.ok) return [];
  const text = await decodeResponse(res);

  const rows = [];
  for (const dataStr of text.split('\n')) {
    const line = dataStr.trim();
    if (!line.includes('=')) continue;
    const idx = line.indexOf('=');
    const stockCode = line.slice(idx - 6, idx); // 去掉 sh/sz/bj 前缀,取 6 位代码
    const f = line.slice(idx + 2, -1).split(','); // 跳过 =" 与结尾 "
    if (f.length < 32) continue;
    const price = toNumSafe(f[3]);
    if (price === null) continue;               // 停牌/无效返回 0 价也走这个分支以外的判断由调用方兜
    rows.push({
      stock_code: stockCode,
      short_name: f[0],
      price,
      open: toNumSafe(f[1]),
      high: toNumSafe(f[4]),
      low: toNumSafe(f[5]),
      last_close: toNumSafe(f[2]),
      volume: toNumSafe(f[8]),                 // 股
      amount: toNumSafe(f[9]),                 // 元
      quote_time: `${f[30]} ${f[31]}`,
    });
  }
  return rows;
}

/**
 * 腾讯全字段实时行情(回退源,浏览器可用)
 * url: https://qt.gtimg.cn/q=sh600519,sz000001   不加 s_ 前缀
 * 返回字段索引:1 名称 2 代码 3 最新价 4 昨收 5 今开 6 成交量(手) 33 最高 34 最低 31 涨跌额 32 涨跌幅 37 成交额(万元) 30 行情时间(YYYYMMDDHHMMSS)
 */
export async function listMarketFullQQ(codeList) {
  const query = codeList
    .map((code) => getExchangeByStockCode(code).toLowerCase() + code)
    .join(',');
  const res = await fetch('https://qt.gtimg.cn/r=' + Math.random() + '&q=' + query);
  if (!res.ok) return [];
  const text = await decodeResponse(res);

  const rows = [];
  for (const dataStr of text.split(';')) {
    if (!dataStr.includes('=')) continue;
    const f = dataStr.split('~');
    if (f.length < 39) continue;
    const price = toNumSafe(f[3]);
    const timeRaw = String(f[30] || '');
    if (price === null) continue;
    rows.push({
      stock_code: f[2],
      short_name: f[1],
      price,
      open: toNumSafe(f[5]),
      high: toNumSafe(f[33]),
      low: toNumSafe(f[34]),
      last_close: toNumSafe(f[4]),
      volume: toNumSafe(f[6]) === null ? null : toNumSafe(f[6]) * 100,  // 手 -> 股
      amount: toNumSafe(f[37]) === null ? null : toNumSafe(f[37]) * 10000, // 万元 -> 元
      quote_time: timeRaw.length >= 14
        ? `${timeRaw.slice(0, 4)}-${timeRaw.slice(4, 6)}-${timeRaw.slice(6, 8)} ${timeRaw.slice(8, 10)}:${timeRaw.slice(10, 12)}:${timeRaw.slice(12, 14)}`
        : '',
    });
  }
  return rows.filter((r) => codeList.includes(r.stock_code));
}

/** 数值安全转换：空串/'-'/'--'/非法 -> null（全字段接口停牌时会给 0 价，由调用方判断） */
function toNumSafe(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '--') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 全字段实时行情（新浪 + 腾讯合并）
 * 浏览器里新浪常被 CORS 拦下、腾讯偶尔部分代码为空，所以两路都跑、按代码合并去重（新浪优先），
 * 不能“新浪为空就丢弃腾讯”或反之。
 * @param {string[]} codeList 6 位代码数组
 * @param {string[]} [diag] 传入数组则逐渠道追加诊断文字，便于工具向模型说明“为什么走到了下一路”
 * @returns {Promise<Array<{stock_code, short_name, price, open, high, low, last_close, volume, amount, quote_time}>>}
 */
export async function listMarketFull(codeList, diag = null) {
  if (!codeList || !codeList.length) return [];
  const total = codeList.length;
  const note = (text) => { if (Array.isArray(diag)) diag.push(text); };
  // 两路并发：一路挂掉不影响另一路（各自 catch，失败只写诊断）
  const [sinaRes, qqRes] = await Promise.all([
    listMarketFullSina(codeList).then(r => ({ rows: r, err: null })).catch(e => ({ rows: [], err: shortErr(e) })),
    listMarketFullQQ(codeList).then(r => ({ rows: r, err: null })).catch(e => ({ rows: [], err: shortErr(e) })),
  ]);
  if (sinaRes.err) note('免费·新浪 失败：' + sinaRes.err);
  if (qqRes.err) note('免费·腾讯 失败：' + qqRes.err);
  const merged = mergeQuotesByCode(sinaRes.rows, qqRes.rows);
  note(merged.length
    ? `免费实时 命中 ${merged.length}/${total}（新浪 ${sinaRes.rows.length}、腾讯补 ${merged.length - sinaRes.rows.length}）`
    : `免费实时 无可用数据（新浪 ${sinaRes.rows.length}、腾讯 ${qqRes.rows.length}）`);
  return merged.map((r) => ({
    ...r,
    change: r.price !== null && r.last_close !== null ? Number((r.price - r.last_close).toFixed(3)) : null,
    change_pct: r.price !== null && r.last_close
      ? Math.round((r.price - r.last_close) / r.last_close * 10000) / 100 : null,
  }));
}

/** 按代码去重合并：前者优先，后者只填前者没拿到的代码 */
function mergeQuotesByCode(primary, secondary) {
  const out = [];
  const seen = new Set();
  for (const r of [...(primary || []), ...(secondary || [])]) {
    const code = r && r.stock_code;
    if (!code || seen.has(code)) continue;
    if (!Number.isFinite(r.price) || r.price <= 0) continue;   // 停牌/脏数据不计入命中
    seen.add(code);
    out.push(r);
  }
  return out;
}

/** 异常摘要（去掉堆栈与长 body，只留一句能给模型看的原因） */
function shortErr(e) {
  const s = String((e && e.message) || e || '未知错误');
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

/**
 * 统一批量行情入口（与小石 xiaoshi_realtime_quote.js 的 batchQuotes 签名一致）
 * @param {string[]} codes - 6 位数字股票代码
 * @param {object}   [opts] - 预留（adata 为公开接口，无需 apiKey）
 * @returns {Promise<{requested, count, items, missing_codes}>}
 * items 每项归一为 { code, name, price, change, change_pct, last_close }。
 * 新浪/腾讯精简接口没有直接的昨收字段，用最新价 - 涨跌额反推。
 */
export async function batchQuotes(codes, opts = {}) {
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('codes 必须是非空数组');
  }
  const rows = await listMarketCurrent(codes);
  const items = rows.map((r) => ({
    code: r.stock_code,
    name: r.short_name,
    price: r.price,
    change: r.change,
    // 涨跌幅四舍五入到小数点后两位（如 -0.8307 → -0.83）
    change_pct: Number.isFinite(r.change_pct) ? Math.round(r.change_pct * 100) / 100 : undefined,
    last_close: Number.isFinite(r.price) && Number.isFinite(r.change)
      ? Number((r.price - r.change).toFixed(2))
      : undefined,
  }));
  const found = new Set(items.map((i) => i.code));
  return {
    requested: codes.length,
    count: items.length,
    missing_codes: codes.filter((c) => !found.has(c)),
    items,
  };
}

// 命令行自测: node adata_realtime_quote.js
if (import.meta.main) {
  (async () => {
    try {
      const data = await listMarketCurrent(['000001', '600001', '000795', '872925']);
      console.table(data);
    } catch (e) {
      console.error('获取实时股价失败:', e.message);
      process.exit(1);
    }
  })();
}
