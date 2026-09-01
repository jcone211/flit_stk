/**
 * K 线(日线/周线/月线)获取模块 —— 个股 / 指数 / ETF 全部数据源整合
 *
 * 从 adata(Python) 移植,覆盖项目内全部 K 线实现:
 *   个股 get_market (stock_market):
 *     - stock_market_east.py  东方财富 push2his(主源)
 *     - stock_market_baidu.py 百度股市通 quotation_kline_ab(回退源)
 *   指数 get_market_index (market_index):
 *     - market_index_east.py  东方财富 push2his(主源)
 *     - market_index_ths.py   同花顺 d.10jqka.com.cn/v4/line(回退源)
 *     - market_index_baidu.py 百度股市通 quotation_index_kline(仅日线)
 *   ETF get_market_etf_ths (fund/market):
 *     - etf_market_ths.py     同花顺 d.10jqka.com.cn/v6/line(唯一源)
 * 附带工具:common/utils/date_utils.py (get_cur_time)、common/headers、stock/cache/index_code_rel_ths.py
 *
 * 回退逻辑:每个标的按源顺序依次尝试,某源失败/返回空则换下一个,全部失败返回 []。
 *
 * 依赖:Node.js 18+ (全局 fetch)
 * 注意:同花顺/百度部分接口为 http 明文,且同花顺依赖静态 Cookie(见 THS_HEADERS),
 *      若被 IP 限流或 Cookie 失效会返回空,由回退链兜底;浏览器环境会因 mixed content
 *      无法访问 http 源,建议在 Node 中使用。
 */

'use strict';

// ========== 通用常量与工具 ==========

/** 通用请求头,新浪/东财等接口无需特殊头 */
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
  Referer: 'https://www.baidu.com/',
};

/** 获取当前日期,格式 YYYYMMDD (对应 date_utils.py 的 get_cur_time("%Y%m%d")) */
function getCurDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** K 线类型参数 (对应 Python 的 f"10{k_type}" if int(k_type) < 5 else k_type) */
function getKTypeParam(kType) {
  const n = Number(kType);
  return n < 5 ? `10${n}` : String(n);
}

/** 数值安全转换:'' / '--' / None / 非法值 -> null */
function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '--' || v === 'None') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/** 四舍五入到 d 位小数,非法值返回 null (对应 pandas round) */
function round(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(Number(n) * f) / f;
}
const round2 = (n) => round(n, 2);
const round3 = (n) => round(n, 3);

/** 日期字符串 YYYYMMDD -> YYYY-MM-DD;已是 YYYY-MM-DD 则原样返回 */
function fmtYmd(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

/** 任意日期时间串 -> 'YYYY-MM-DD HH:MM:SS'(仅日期则补 00:00:00) */
function normalizeDateTime(v) {
  if (!v) return null;
  let s = String(v).trim().replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00:00';
  return s;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带网络重试的 JSON 请求:仅对抛出的网络异常重试(retries 次),HTTP 非 2xx 视为空数据返回 null。
 * 网络异常重试耗尽后向上抛出,交由 trySources 回退到下一数据源。
 */
async function fetchJsonWithRetry(url, init = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 依次尝试数据源,第一个返回非空数组的结果即采纳;全部失败返回 [] */
async function trySources(fetchers) {
  for (const fetchFn of fetchers) {
    try {
      const rows = await fetchFn();
      if (Array.isArray(rows) && rows.length) return rows;
    } catch (e) {
      // 源请求失败,继续尝试下一个
    }
  }
  return [];
}

/**
 * 读取响应并按其 Content-Type 声明的 charset 解码。
 * 百度等接口返回 GBK/GB2312,res.text() 恒按 UTF-8 解码会导致中文乱码,
 * 但本模块 K 线数据均为数值/日期,此工具保留以兼容后续扩展。
 */
async function decodeResponse(res) {
  const buf = await res.arrayBuffer();
  const charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || 'utf-8';
  const enc = /^gbk$/i.test(charset) || /^gb2312$/i.test(charset) || /^gb18030$/i.test(charset) ? 'gbk' : 'utf-8';
  return new TextDecoder(enc).decode(buf);
}

// ========== 个股 K 线 ==========

// 东方财富历史 K 线接口(个股)
const EM_STOCK_KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const EM_STOCK_UT = '7eea3edcaed734bea9cbfc24409ed989';

/**
 * 东方财富个股 K 线 (对应 stock_market_east.py::get_market)
 * klines 每行为: trade_date,open,close,high,low,volume(手),amount,振幅,change_pct,change,turnover_ratio
 */
async function fetchStockKlineEast(stockCode, { startDate = '1990-01-01', endDate, kType = 1, adjustType = 1 } = {}) {
  const params = new URLSearchParams({
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116',
    ut: EM_STOCK_UT,
    klt: getKTypeParam(kType),
    fqt: String(adjustType),
    secid: `${stockCode.startsWith('6') ? 1 : 0}.${stockCode}`,
    beg: startDate.replace(/-/g, '') || '19900101',
    end: (endDate && endDate.replace(/-/g, '')) || getCurDate(),
    _: String(Date.now()),
  });
  const dataJson = await fetchJsonWithRetry(`${EM_STOCK_KLINE_URL}?${params}`, { headers: COMMON_HEADERS });
  if (!dataJson || !dataJson.data || !dataJson.data.klines) return [];
  return dataJson.data.klines.map((line) => {
    const p = line.split(',');
    const change = toNum(p[9]);
    const close = toNum(p[2]);
    return {
      stock_code: stockCode,
      trade_time: `${p[0]} 00:00:00`,
      trade_date: p[0],
      open: toNum(p[1]),
      close,
      high: toNum(p[3]),
      low: toNum(p[4]),
      volume: parseInt(p[5], 10) * 100, // 手 -> 股
      amount: toNum(p[6]),
      change_pct: toNum(p[8]),
      change,
      turnover_ratio: toNum(p[10]),
      // 昨收 = 收盘 - 涨跌额
      pre_close: (close !== null && change !== null) ? round2(close - change) : null,
    };
  });
}

// 百度股市通 个股 K 线 请求头 (对应 common/headers/baidu_headers.py 的 json_headers)
const BAIDU_HEADERS = {
  Host: 'finance.pae.baidu.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/110.0',
  Accept: 'application/vnd.finance-web.v1+json',
  'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
  'Content-Type': 'application/json',
  Origin: 'https://gushitong.baidu.com',
  Connection: 'keep-alive',
  Referer: 'https://gushitong.baidu.com/',
  Cookie: 'BAIDUID=5D6B41AD5BE03619A214B371970EB643:FG=1; BIDUPSID=72A958B07427F9F9CB3F63FD8B6C6565; PSTM=1723618492; ZFY=USOzWykRABpB9kTNtM29hNaXpj:AfNf0O65YLgmVy2Fg:C; H_PS_PSSID=60274_60359_60599_60607_60664_60677_60674_60694_60709; BA_HECTOR=252hagaka4alah2g81a4818036oger1jdasff1u; PSINO=6; delPer=0; BDORZ=B490B5EBF6F3CD402E515D22BCDA1598; ab_sr=1.0.1_M2I1MThhZjNiZTMwYzJiZTA1N2RiOTAzZGI4OGZiZTZiOGZiY2RmZTQyY2YxZTlmYWFkZjExODhjZmY1MGM1N2M1YjBlZjhkMzNmZmY3ZjVkYmJmZDE0ODM1MTg5NTQ3MDJkZTFiMGM4MTViMWU2YmYxYjU3ZmVlZGM5NDVhOWIzOWQwMTBmMzBmNTk4NWQ2MmMwYjQ5MDdhNjI2MDY3OA==',
};

/** 百度动态 keys 数据 -> 按 keys 顺序拼装为对象数组,并按 rename 映射字段名 */
function buildRowsFromKeys(keys, marketData, rename) {
  return String(marketData)
    .split(';')
    .filter((s) => s.length)
    .map((part) => {
      const fields = part.split(',');
      const obj = {};
      keys.forEach((k, i) => { obj[rename[k] || k] = fields[i]; });
      return obj;
    });
}

/**
 * 百度股市通 个股 K 线 (对应 stock_market_baidu.py::get_market)
 * ktype 直接传 1/2/3(日/周/月);adjust_type 复权未实现(TODO),忽略。
 * 注意:接口不支持下发日期范围,仅支持 start_time。
 */
async function fetchStockKlineBaidu(stockCode, { startDate = '1990-01-01', kType = 1 } = {}) {
  const url = `https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=false&isBk=false&isBlock=false&isFutures=false&isStock=true&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${stockCode}&start_time=${startDate} 00:00:00&ktype=${kType}`;
  let json = null;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: BAIDU_HEADERS });
    if (res.ok) json = await res.json();
    if (json && json.ResultCode === '0') break;
    await sleep(2000);
  }
  if (!json || json.ResultCode !== '0' || !json.Result || !json.Result.newMarketData) return [];

  const rename = {
    turnoverratio: 'turnover_ratio', preClose: 'pre_close', range: 'change',
    ratio: 'change_pct', time: 'trade_time',
  };
  const { keys, marketData } = json.Result.newMarketData;
  // 剔除成交量且成交额都为 0 的异常数据,再拼装为标准个股字段
  return buildRowsFromKeys(keys, marketData, rename)
    .filter((o) => (toNum(o.amount) > 0) || (toNum(o.volume) > 0))
    .map((o) => ({
      stock_code: stockCode,
      trade_time: normalizeDateTime(o.trade_time),
      trade_date: o.trade_time ? fmtYmd(o.trade_time) : null,
      open: toNum(o.open),
      close: toNum(o.close),
      high: toNum(o.high),
      low: toNum(o.low),
      volume: toNum(o.volume),
      amount: toNum(o.amount),
      change_pct: toNum(o.change_pct),
      change: toNum(o.change),
      turnover_ratio: toNum(o.turnover_ratio),
      pre_close: toNum(o.pre_close),
    }));
}

/**
 * 获取单个股票的 K 线(主源东方财富,失败回退百度)
 * @param {string} stockCode 6 位股票代码,如 '000001'
 * @param {Object} [options]
 * @param {string} [options.startDate='1990-01-01'] 开始日期 YYYY-MM-DD
 * @param {string} [options.endDate]                结束日期 YYYY-MM-DD,默认今天
 * @param {number} [options.kType=1]                K 线类型:1 日、2 周、3 月
 * @param {number} [options.adjustType=1]           复权:0 不复权、1 前复权、2 后复权
 * @returns {Promise<Array<Object>>}
 */
async function getMarket(stockCode = '000001', options = {}) {
  return trySources([
    () => fetchStockKlineEast(stockCode, options),
    () => fetchStockKlineBaidu(stockCode, options),
  ]);
}

/** 个股日线 */
async function getMarketDaily(stockCode, options = {}) { return getMarket(stockCode, { ...options, kType: 1 }); }
/** 个股周线 */
async function getMarketWeekly(stockCode, options = {}) { return getMarket(stockCode, { ...options, kType: 2 }); }
/** 个股月线 */
async function getMarketMonthly(stockCode, options = {}) { return getMarket(stockCode, { ...options, kType: 3 }); }

// ========== 指数 K 线 ==========

// 东方财富历史 K 线接口(指数,ut 与个股不同)
const EM_INDEX_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

/**
 * 东方财富指数 K 线 (对应 market_index_east.py::get_market_index)
 * secid 市场编号:93 开头 -> 2;0 开头 -> 1;其余 -> 0
 */
async function fetchIndexKlineEast(indexCode, { startDate = '2020-01-01', kType = 1 } = {}) {
  let secId = 0;
  if (indexCode.startsWith('93')) secId = 2;
  else if (indexCode.startsWith('0')) secId = 1;
  const params = new URLSearchParams({
    secid: `${secId}.${indexCode}`,
    ut: EM_INDEX_UT,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    klt: getKTypeParam(kType),
    fqt: '1',
    beg: startDate ? startDate.replace(/-/g, '') : '0',
    end: '20500101',
    smplmt: '100000',
    lmt: '1000000',
    _: String(Date.now()),
  });
  // Python 版对指数走 POST 请求,保持兼容
  const dataJson = await fetchJsonWithRetry(`${EM_STOCK_KLINE_URL}?${params}`, { method: 'POST', headers: COMMON_HEADERS });
  if (!dataJson || !dataJson.data || dataJson.data.code !== indexCode || !dataJson.data.klines) return [];
  return dataJson.data.klines.map((line) => {
    const p = line.split(',');
    return {
      index_code: indexCode,
      trade_date: p[0],
      trade_time: `${p[0]} 00:00:00`,
      open: round2(p[1]),
      high: round2(p[3]),
      low: round2(p[4]),
      close: round2(p[2]),
      volume: round2(p[5]),
      amount: round2(p[6]),
      change: round2(p[9]),
      change_pct: round2(p[8]),
    };
  });
}

// 同花顺 请求头 (对应 common/headers/ths_headers.py 的 text_headers)
// 注:Python 版 Cookie 由 ths.js 动态生成,这里采用其内置静态 Cookie;
//    若失效同花顺源会返回空,由回退链兜底。
const THS_HEADERS = {
  Host: 'q.10jqka.com.cn',
  Referer: 'http://q.10jqka.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:105.0) Gecko/20100101 Firefox/105.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
  Connection: 'keep-alive',
  Cookie: 'v=AzCSZkisIBam9fwSniGPJndtB_-HeRW6Nl9qaSqB_nJczN4r0onkU4ZtOEN5; __bid_n=18484da3254140db6d4207; Hm_lvt_78c58f01938e4d85eaf619eae71b4ed1=1680163246; FPTOKEN=E5SR2waOvFusCzMCQVA/i0npfLNEl6RajFMppa8aoQmLTnIl68wGldxUBmPM57Q9yOCUCB1aiKbuSjFdBzV5SnHNhe0uSYQIfJ9t5YdBrYTHtRO06p0Kjf3ck0dxo587GXZ/Lln6kY2EoiWCZBlXHLfwWq6d/uLzQfq+BnkeN8y5zWt6kJAzY84fZaTCNQPf4Vae5qHOYpskzus+szaS5Qm2VNc/Q/t/0U7QQADRzNRLfYf6A/407ZMdD6+1sGvCQhh959iGl+DRavRasWH2ISY3G/osl/olB61tXSIxNI+IL+rAu7u5TvknHHwVtcigMY4jsgE8qBkN2HU4wDvH5QMv+0E89L5jACYIF+BoMaBNN6VkPt9Pksg8+K6O4K9rwElcjiWRuyzNy25YO13lYQ==|sPeLn4kqSDrmYnpF7Wn94V4caIa/qNc5YWTtvQFK+ac=|10|2bc6aba78093d71b50d1b70dd20ef09d; Hm_lpvt_78c58f01938e4d85eaf619eae71b4ed1=1680163469',
};

/** 同花顺 IP 限流返回特征 (对应 THS_IP_LIMIT_RES) */
const THS_IP_LIMIT_RES = '<h1>Nginx forbidden.</h1>';

/** 同花顺文本接口:最多重试 2 次,响应中包含代码才算成功 (对应 base_ths.py::_get_text) */
async function fetchThsText(url, code) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers: { ...THS_HEADERS, Host: 'd.10jqka.com.cn' } });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes(code)) return text;
    } catch (e) {
      // 重试
    }
  }
  return '';
}

/** 提取同花顺返回文本中的 JSON 对象(形如 prefix{...};,去掉头尾噪声) */
function parseThsJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let s = text.slice(start).trim();
  while (s.length && !s.endsWith('}')) s = s.slice(0, -1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** 标准指数代码 -> 同花顺代码 (对应 stock/cache/index_code_rel_ths.py 的 rel,仅保留正向映射) */
const THS_INDEX_REL = {
  '000819': '1B0819', '000006': '1B0004', '000823': '1B0823', '000867': '1B0867',
  '000989': '1B0989', '000987': '1B0987', '000033': '1B0033', '000071': '1B0071',
  '000035': '1B0035', '000854': '1B0854', '000107': '1B0107', '000092': '1B0092',
  '000126': '1B0126', '000026': '1B0026', '000145': '1B0145', '000073': '1B0073',
  '000094': '1B0094', '000105': '1B0105', '000869': '1B0869', '000027': '1B0027',
  '000135': '1B0135', '000066': '1B0066', '000068': '1B0068', '000692': '1B0692',
  '000932': '1B0932', '000170': '1B0170', '000036': '1B0036', '000903': '1B0903',
  '000057': '1B0057', '000016': '1B0016', '000063': '1B0063', '000074': '1B0074',
  '000055': '1B0055', '000052': '1B0052', '000914': '1B0914', '000028': '1B0028',
  '000069': '1B0069', '000043': '1B0043', '000102': '1B0102', '000992': '1B0992',
  '000934': '1B0934', '000849': '1B0849', '000689': '1B0689', '000048': '1B0048',
  '000827': '1B0827', '000300': '1B0300', '000021': '1B0021', '000123': '1B0123',
  '000038': '1B0038', '000093': '1B0093', '000853': '1B0853', '000030': '1B0030',
  '000059': '1B0059', '000117': '1B0117', '000155': '1B0155', '000906': '1B0906',
  '000010': '1B0007', '000049': '1B0049', '000050': '1B0050', '000974': '1B0974',
  '000104': '1B0104', '000125': '1B0125', '000141': '1B0141', '000018': '1B0018',
  '000019': '1B0019', '000003': '1A0003', '000029': '1B0029', '000054': '1B0054',
  '000096': '1B0096', '000697': '1B0697', '000031': '1B0031', '000137': '1B0137',
  '000119': '1B0119', '000149': '1B0149', '000056': '1B0056', '000047': '1B0047',
  '000051': '1B0051', '000108': '1B0108', '000053': '1B0053', '000058': '1B0058',
  '000901': '1B0901', '000986': '1B0986', '000159': '1B0159', '000133': '1B0133',
  '000132': '1B0132', '000158': '1B0158', '950096': '1B0865', '000090': '1B0090',
  '000928': '1B0928', '000032': '1B0032', '000147': '1B0147', '000148': '1B0148',
  '000905': '1B0905', '000064': '1B0064', '000091': '1B0091', '000011': '1B0008',
  '000687': '1B0687', '000060': '1B0060', '000004': '1B0001', '000856': '1B0856',
  '000065': '1B0065', '000070': '1B0070', '000098': '1B0098', '000847': '1B0847',
  '000100': '1B0100', '991001': '1C0003', '000067': '1B0067', '000852': '1B0852',
  '000005': '1B0002', '000802': '1B0802', '000020': '1B0020', '000001': '1A0001',
  '000017': '1B0017', '000134': '1B0134', '000002': '1A0002', '000099': '1B0099',
  '000076': '1B0076', '000044': '1B0044', '000982': '1B0982', '000009': '1B0009',
  '000046': '1B0046', '000103': '1B0103', '000891': '1B0891', '000095': '1B0095',
  '000160': '1B0160', '000851': '1B0851', '000690': '1B0690', '000008': '1B0006',
  '000045': '1B0045', '000161': '1B0161', '000153': '1B0153', '000146': '1B0146',
  '000913': '1B0913', '000139': '1B0139', '000042': '1B0042', '000129': '1B0129',
  '000122': '1B0122', '000062': '1B0062', '000693': '1B0693', '000115': '1B0115',
  '000106': '1B0106', '000034': '1B0034', '000040': '1B0040', '000110': '1B0110',
  '000128': '1B0128', '000072': '1B0072', '000118': '1B0118', '000860': '1B0860',
  '000120': '1B0120', '000991': '1B0991', '000114': '1B0114', '000933': '1B0933',
  '000142': '1B0142', '000152': '1B0152', '000111': '1B0111', '000097': '1B0097',
  '000814': '1B0814', '000138': '1B0138', '000695': '1B0695', '000136': '1B0136',
  '000037': '1B0037', '000858': '1B0858', '000993': '1B0993', '000935': '1B0935',
  '000688': '1B0688', '000078': '1B0078', '000162': '1B0162', '000015': '1B0015',
  '000116': '1B0116', '000061': '1B0061', '000863': '1B0863', '000022': '1B0022',
  '000101': '1B0101', '000012': '1B0012', '000683': '1B0683', '000007': '1B0005',
  '000130': '1B0130', '000079': '1B0079', '000077': '1B0077', '000113': '1B0113',
  '000075': '1B0075', '000121': '1B0121', '000857': '1B0857', '000682': '1B0682',
  '000025': '1B0025', '000041': '1B0041', '000039': '1B0039', '000151': '1B0151',
  '000109': '1B0109', '000150': '1B0150', '000112': '1B0112', '000685': '1B0685',
  '000131': '1B0131',
};

/**
 * 根据开始时间生成需要请求的年份列表 (对应 base_ths.py::_get_years_by_start_date)
 * 例:start_date=2020-10-01 -> [2019, 2020, ..., current-1, current];空 -> ['last']
 */
function getYearsByStartDate(startDate) {
  if (!startDate) return ['last'];
  const currentYear = new Date().getFullYear();
  const years = [];
  let startYear = parseInt(startDate.slice(0, 4), 10);
  while (startYear <= currentYear) {
    years.push(startYear - 1);
    startYear += 1;
  }
  if (!years.includes(currentYear)) years.push(currentYear);
  return years;
}

/**
 * 同花顺指数 K 线 (对应 market_index_ths.py::get_market_index)
 * url: http://d.10jqka.com.cn/v4/line/zs_{code}/{k_type-1}1/{year}.js
 */
async function fetchIndexKlineThs(indexCode, { startDate = '2020-01-01', kType = 1 } = {}) {
  const thsCode = THS_INDEX_REL[indexCode] || indexCode;
  const years = getYearsByStartDate(startDate);
  const raw = [];
  for (const year of years) {
    const url = `http://d.10jqka.com.cn/v4/line/zs_${thsCode}/${kType - 1}1/${year}.js`;
    const text = await fetchThsText(url, thsCode);
    if (!text) continue;
    if (text.includes(THS_IP_LIMIT_RES)) return [];
    const obj = parseThsJson(text);
    if (!obj || !obj.data) continue;
    for (const d of String(obj.data).split(';')) {
      if (!d) continue;
      const f = d.split(',');
      if (f.length < 7) continue;
      raw.push({ trade_date: f[0], open: f[1], high: f[2], low: f[3], close: f[4], volume: f[5], amount: f[6] });
    }
  }
  if (!raw.length) return [];

  // 去重并按日期升序
  const seen = new Set();
  const sorted = raw
    .filter((r) => { if (seen.has(r.trade_date)) return false; seen.add(r.trade_date); return true; })
    .sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  // 计算涨跌额/涨跌幅(相对前一日收盘),清洗后筛选时间范围
  return sorted.map((r, i) => {
    const close = toNum(r.close);
    const prevClose = i > 0 ? toNum(sorted[i - 1].close) : null;
    const change = (i > 0 && prevClose !== null) ? round2(close - prevClose) : null;
    const changePct = (i > 0 && prevClose) ? round2((close - prevClose) / prevClose * 100) : null;
    const tradeDate = fmtYmd(r.trade_date);
    return {
      index_code: indexCode,
      trade_date: tradeDate,
      trade_time: `${tradeDate} 00:00:00`,
      open: toNum(r.open),
      high: toNum(r.high),
      low: toNum(r.low),
      close,
      volume: toNum(r.volume),
      amount: toNum(r.amount),
      change,
      change_pct: changePct,
    };
  }).filter((r) => (startDate ? r.trade_date >= startDate : true));
}

/**
 * 百度股市通 指数 K 线 (对应 market_index_baidu.py::get_market_index)
 * 注意:接口 ktype 恒为 day(仅日线),Python 版忽略了 k_type 参数,
 *      这里仅当 kType 为日线时参与回退,避免周/月线拿到日线数据。
 */
async function fetchIndexKlineBaidu(indexCode, { startDate = '2020-01-01', kType = 1 } = {}) {
  if (Number(kType) !== 1) return [];
  const url = `https://finance.pae.baidu.com/vapi/v1/getquotation?srcid=5353&all=1&pointType=string&group=quotation_index_kline&query=${indexCode}&code=${indexCode}&market_type=ab&newFormat=1&is_kc=0&ktype=day&finClientType=pc`;
  let json = null;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: BAIDU_HEADERS });
    if (res.ok) json = await res.json();
    if (json && json.ResultCode === '0') break;
    await sleep(2000);
  }
  if (!json || json.ResultCode !== '0' || !json.Result || !json.Result.newMarketData) return [];

  const rename = {
    turnoverratio: 'turnover_ratio', preClose: 'pre_close', range: 'change',
    ratio: 'change_pct', time: 'trade_time',
  };
  const { keys, marketData } = json.Result.newMarketData;
  return buildRowsFromKeys(keys, marketData, rename)
    .filter((o) => (toNum(o.amount) > 0) || (toNum(o.volume) > 0))
    .map((o) => {
      const tradeDate = fmtYmd(o.trade_time);
      return {
        index_code: indexCode,
        trade_date: tradeDate,
        trade_time: normalizeDateTime(o.trade_time),
        open: toNum(o.open),
        high: toNum(o.high),
        low: toNum(o.low),
        close: toNum(o.close),
        volume: toNum(o.volume),
        amount: toNum(o.amount),
        change: toNum(o.change),
        change_pct: toNum(o.change_pct),
      };
    })
    .filter((r) => (startDate ? r.trade_date >= startDate : true));
}

/**
 * 获取指数 K 线(主源东方财富,回退同花顺,再回退百度[仅日线])
 * @param {string} indexCode 指数代码,如 '000001' 上证指数 / '399001' 深证成指 / '000300' 沪深300
 * @param {Object} [options]
 * @param {string} [options.startDate='2020-01-01'] 开始日期 YYYY-MM-DD
 * @param {number} [options.kType=1] K 线类型:1 日、2 周、3 月
 * @returns {Promise<Array<Object>>}
 */
async function getMarketIndex(indexCode = '000001', options = {}) {
  const { kType = 1 } = options;
  return trySources([
    () => fetchIndexKlineEast(indexCode, options),
    () => fetchIndexKlineThs(indexCode, options),
    () => fetchIndexKlineBaidu(indexCode, options),
  ]);
}

/** 指数日线 */
async function getMarketIndexDaily(indexCode, options = {}) { return getMarketIndex(indexCode, { ...options, kType: 1 }); }
/** 指数周线 */
async function getMarketIndexWeekly(indexCode, options = {}) { return getMarketIndex(indexCode, { ...options, kType: 2 }); }
/** 指数月线 */
async function getMarketIndexMonthly(indexCode, options = {}) { return getMarketIndex(indexCode, { ...options, kType: 3 }); }

// ========== ETF K 线 ==========

/**
 * 同花顺 ETF K 线 (对应 etf_market_ths.py::get_market_etf_ths,唯一源)
 * url: http://d.10jqka.com.cn/v6/line/hs_{code}/{k_type-1}1/last36000.js
 * 01 日前复权 / 11 周前复权 / 21 月前复权
 */
async function fetchEtfKlineThs(fundCode, { kType = 1, startDate = '', endDate = '' } = {}) {
  const url = `http://d.10jqka.com.cn/v6/line/hs_${fundCode}/${kType - 1}1/last36000.js`;
  const text = await fetchThsText(url, fundCode);
  if (!text) return [];
  if (text.includes(THS_IP_LIMIT_RES)) return [];
  const obj = parseThsJson(text);
  if (!obj || !obj.data || Number(obj.total) === 0) return [];

  const raw = [];
  for (const d of String(obj.data).split(';')) {
    if (!d) continue;
    const f = d.split(',');
    if (f.length < 7) continue;
    raw.push({ trade_date: f[0], open: f[1], high: f[2], low: f[3], close: f[4], volume: f[5], amount: f[6] });
  }

  // 剔除成交量为 0 的行,再计算涨跌额/涨跌幅(相对前一行收盘)
  const rows = raw
    .filter((r) => r.volume !== '0')
    .map((r, i, arr) => {
      const close = toNum(r.close);
      const prevClose = i > 0 ? toNum(arr[i - 1].close) : null;
      const change = (i > 0 && prevClose !== null) ? round3(close - prevClose) : null;
      const changePct = (i > 0 && prevClose) ? round3((close - prevClose) / prevClose * 100) : null;
      const tradeDate = fmtYmd(r.trade_date);
      return {
        fund_code: fundCode,
        trade_time: `${tradeDate} 00:00:00`,
        trade_date: tradeDate,
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close,
        volume: toNum(r.volume),
        amount: toNum(r.amount),
        change,
        change_pct: changePct,
      };
    });

  // 时间范围筛选
  const start = startDate || '1990-01-01';
  const end = endDate || '2099-01-01';
  return rows.filter((r) => r.trade_date >= start && r.trade_date <= end);
}

/**
 * 获取 ETF K 线(同花顺,唯一源)
 * @param {string} fundCode ETF 代码,如 '512880'
 * @param {Object} [options]
 * @param {number} [options.kType=1] K 线类型:1 日、2 周、3 月
 * @param {string} [options.startDate] 开始日期 YYYY-MM-DD,默认全量
 * @param {string} [options.endDate]   结束日期 YYYY-MM-DD,默认到 2099
 * @returns {Promise<Array<Object>>}
 */
async function getMarketEtf(fundCode = '512880', options = {}) {
  return trySources([() => fetchEtfKlineThs(fundCode, options)]);
}

/** ETF 日线 */
async function getMarketEtfDaily(fundCode, options = {}) { return getMarketEtf(fundCode, { ...options, kType: 1 }); }
/** ETF 周线 */
async function getMarketEtfWeekly(fundCode, options = {}) { return getMarketEtf(fundCode, { ...options, kType: 2 }); }
/** ETF 月线 */
async function getMarketEtfMonthly(fundCode, options = {}) { return getMarketEtf(fundCode, { ...options, kType: 3 }); }

export {
  // 公共入口(含源回退)
  getMarket, getMarketDaily, getMarketWeekly, getMarketMonthly,
  getMarketIndex, getMarketIndexDaily, getMarketIndexWeekly, getMarketIndexMonthly,
  getMarketEtf, getMarketEtfDaily, getMarketEtfWeekly, getMarketEtfMonthly,
  // 各数据源底层接口(便于单独调试/指定源)
  fetchStockKlineEast, fetchStockKlineBaidu,
  fetchIndexKlineEast, fetchIndexKlineThs, fetchIndexKlineBaidu,
  fetchEtfKlineThs,
};

// 命令行自测: node adata_stock_kline.js
if (import.meta.main) {
  (async () => {
    try {
      const startDate = '2026-06-01';
      const show = (name, rows) => console.log(`\n== ${name} 共 ${rows.length} 条 ==\n${JSON.stringify(rows.slice(-2), null, 1)}`);

      // 个股(东财主源)
      show('个股日线 000001', await getMarket('000001', { startDate }));
      show('个股周线 000001', await getMarketWeekly('000001', { startDate }));
      show('个股月线 000001', await getMarketMonthly('000001', { startDate }));
      // 指数(东财主源 -> 同花顺 -> 百度)
      show('指数日线 000001(上证指数)', await getMarketIndex('000001', { startDate }));
      show('指数日线 399001(深证成指)', await getMarketIndex('399001', { startDate }));
      // ETF(同花顺)
      show('ETF 日线 512880', await getMarketEtf('512880', { startDate }));
      show('ETF 周线 512880', await getMarketEtfWeekly('512880', { startDate }));
    } catch (e) {
      console.error('获取 K 线失败:', e.message);
      process.exit(1);
    }
  })();
}
