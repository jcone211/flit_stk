#!/usr/bin/env node
/**
 * docs/read-debug.mjs —— DEBUG 日志（docs/debug.txt）专用读取器
 *
 * 为什么要有它：debug.txt 里经常混着超长的数据行（工具返回 result: {...} JSON、
 * 跨轮数据便签、AI 回复原文，实测最长 3719 字/行），直接整文件读会刷爆上下文。
 * 本脚本每次要读 debug.txt 时代替直接打开，负责：
 *   1) 统计每一行的字符长度：总行数 / 总字符 / 平均 / 最长行 / 长度分布桶 / 超长行 TOP；
 *   2) 正文逐行输出，带「行号·原长」前缀；超长行按阈值截断（保留开头 + 结尾，
 *      中间留省略标记并注明原长），既省空间又保留信息；
 *   3) 支持只看统计 / 只看超长行 / 只看开头或结尾，按需控制输出量。
 *
 * 用法：
 *   node docs/read-debug.mjs                     读 docs/debug.txt（默认紧凑模式：事件级折叠压缩）
 *   node docs/read-debug.mjs --full              逐行完整版（只按行长截断，不折叠事件）
 *   node docs/read-debug.mjs --compact           强制紧凑模式（默认已开）
 *   node docs/read-debug.mjs <文件路径>           读指定文件
 *   node docs/read-debug.mjs --max 400           单行显示上限改为 400 字符（默认 600）
 *   node docs/read-debug.mjs --stats-only        只看统计摘要，不输出正文
 *   node docs/read-debug.mjs --long-only         只看超长行明细
 *   node docs/read-debug.mjs --no-prefix         正文不打印「行号·长度」前缀
 *   node docs/read-debug.mjs --limit 80          正文只看前 80 行（统计仍基于全文件）
 *   node docs/read-debug.mjs --tail 30           正文只看末尾 30 行
 *   node docs/read-debug.mjs --tail-ratio 0.3    超长行保留前 70% + 末尾 30%（默认 0.3）
 *   node docs/read-debug.mjs --help              帮助
 *
 * 紧凑模式压缩点：发起请求/模型响应折叠固定字段为一行；相同 result 引用省略；
 * 报错按块一行；跨轮账本/便签只留标题摘要；用户问题/AI 回复/工具调用 args 保留原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const opt = {
    file: null, max: 600, statsOnly: false, longOnly: false,
    noPrefix: false, limit: null, tail: null, tailRatio: 0.3, help: false, full: false,
  };
  const positional = [];
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`参数需要数字，收到「${v}」`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--max': opt.max = num(argv[++i]); break;
      case '--stats-only': case '-s': opt.statsOnly = true; break;
      case '--long-only': case '-l': opt.longOnly = true; break;
      case '--no-prefix': opt.noPrefix = true; break;
      case '--limit': opt.limit = Math.max(0, Math.floor(num(argv[++i]))); break;
      case '--tail': opt.tail = Math.max(0, Math.floor(num(argv[++i]))); break;
      case '--tail-ratio': opt.tailRatio = Math.max(0, Math.min(0.5, num(argv[++i]))); break;
      case '--full': opt.full = true; break;
      case '--compact': case '-c': opt.full = false; break;
      case '-h': case '--help': opt.help = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`未知参数：${a}`);
        positional.push(a);
    }
  }
  opt.file = positional[0] ?? null;
  if (opt.limit && opt.tail) throw new Error('--limit 与 --tail 二选一（limit 取开头、tail 取末尾）');
  if (opt.statsOnly && opt.longOnly) throw new Error('--stats-only 与 --long-only 二选一');
  return opt;
}

function helpText() {
  return `docs/read-debug.mjs —— DEBUG 日志专用读取器

用法:
  node docs/read-debug.mjs [<文件路径>] [选项]

选项:
  --max <n>          单行显示上限（默认 600 字符，超长即截断并注明原长）
  --full             逐行完整版：不折叠事件块，只按行长截断
  --compact/-c       紧凑模式（默认开启）：事件级折叠重复字段/相同 result/报错/账本
  --stats-only/-s    只看统计摘要（行数/长度分布/最长/超长 TOP），不输出正文
  --long-only/-l     只看超长行明细（原长超过阈值的行）
  --no-prefix        正文不打印「行号·长度」前缀
  --limit <n>        正文只看前 n 行（统计仍基于全文件）
  --tail <n>         正文只看末尾 n 行
  --tail-ratio <r>   超长行保留头部比例倒推尾部（默认 0.3：前 70% + 末 30%）
  -h/--help          帮助

默认文件: docs/debug.txt（相对当前目录；找不到时依次回退脚本上级目录）。
`;
}

// ---------------------------------------------------------------- 读文件
function loadLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const raw = text.split(/\r\n|\r|\n/); // 兼容 CRLF / LF
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const lines = raw.map((t) => ({ len: Array.from(t).length, text: t }));
  return { text, lines };
}

// 超长行截断：保留前 keep、后 tail，中间插省略标记（附原长）
function truncate(s, max, tailRatio) {
  const cp = Array.from(s);
  const n = cp.length;
  if (n <= max) return { body: s, cut: false, origLen: n };
  const tail = Math.max(4, Math.floor(max * tailRatio));
  const keep = Math.max(8, max - tail - 1);
  const marker = ` ⋯[截断 原长${n}字]`;
  const head = cp.slice(0, keep).join('');
  const tailText = cp.slice(n - tail).join('');
  return { body: head + marker + tailText, cut: true, origLen: n };
}

// ---------------------------------------------------------------- 统计
const BUCKETS = [
  ['≤10', 10], ['11–50', 50], ['51–100', 100], ['101–200', 200],
  ['201–500', 500], ['501–1000', 1000], ['1001–2000', 2000], ['>2000', Infinity],
];

function computeStats(lines, max) {
  let totalChars = 0, maxLen = 0, maxIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = lines[i].len;
    totalChars += n;
    if (n > maxLen) { maxLen = n; maxIdx = i + 1; }
  }
  const buckets = BUCKETS.map(([name, limit]) => ({ name, limit, count: 0 }));
  lines.forEach(({ len }) => {
    const b = buckets.find((x) => len <= x.limit);
    if (b) b.count++;
  });
  const longLines = lines
    .map((l, i) => ({ ...l, idx: i + 1 }))
    .filter((l) => l.len > max);
  return { totalChars, maxLen, maxIdx, buckets, longLines, avg: lines.length ? totalChars / lines.length : 0 };
}

// ---------------------------------------------------------------- 输出
const BAR = '='.repeat(74);

function printStats(fname, bytes, stats, max) {
  console.log(BAR);
  console.log(`read-debug · ${fname}`);
  console.log(`  文件 ${bytes} 字节 | 总行数 ${stats.totalLines} | 总字符 ${stats.totalChars.toLocaleString()} | 平均 ${stats.avg.toFixed(1)} 字/行`);
  console.log(`  最长行 L${String(stats.maxIdx).padStart(3, '0')} · ${stats.maxLen} 字 | 单行截断阈值 ${max} 字`);
  console.log(`  超长行 ${stats.longLines.length} 个（占总行数 ${((stats.longLines.length / stats.totalLines) * 100).toFixed(2)}%）`);
  console.log('');
  console.log('  行长分布（每行字符数）:');
  for (const b of stats.buckets) {
    const bar = '█'.repeat(Math.round((b.count / stats.totalLines) * 60));
    console.log(`    ${b.name.padEnd(9)} ${String(b.count).padStart(5)} 行  ${bar}`);
  }
}

function printLongLines(stats, max, tailRatio) {
  const ls = stats.longLines;
  console.log('');
  console.log(`超长行明细（原长 > ${max} 字，共 ${ls.length} 行，超出部分截断）:`);
  if (!ls.length) {
    console.log('  （无）');
    return;
  }
  for (const l of ls) {
    const { body } = truncate(l.text, max, tailRatio);
    console.log(`  L${String(l.idx).padStart(3, '0')}·${l.len}字> ${body}`);
  }
}

// ================================================================
// 紧凑模式：结构感知的内容级压缩（默认开启；--full 回到逐行版）
// 压缩点：
//   · 发起请求 / 模型响应 —— 折叠固定字段为一行摘要（baseUrl 等只完整显示第一次）
//   · 工具调用 —— 保留 args（多行 JSON 展平为一行）
//   · 工具返回 —— 保留关键指标与 result；result 与此前完全相同时引用省略
//   · 报错信息 —— 每块压缩成一行（主体/在途/连续重复/首次）
//   · 跨轮工具记录 —— 只留标题摘要（明细已在前述工具调用/返回里出现）
//   · 跨轮数据便签 —— content 为某 result 复本时引用省略，否则截断展示
//   · 用户问题 / AI 回复 / 反编造拦截 / 系统提示 —— 保留原文（排障核心）
// ================================================================
const HEAD_RE = /^\s*\[\d+\]\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(.+)$/;
const isHead = (s) => HEAD_RE.test(s);
const headType = (s) => { const m = HEAD_RE.exec(s); return m ? m[1] : ''; };
const headClock = (s) => { const m = s.match(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/); return m ? m[0] : ''; };

// 块内 `  key: value` 字段（缩进两格）
function fieldLines(b) {
  const f = {};
  for (const l of b) {
    const m = l.text.match(/^\s{2}([^:\s][^:]*):\s*(.*)$/);
    if (m) f[m[1].trim()] = m[2].trim();
  }
  return f;
}

// 工具调用块的 args（多行 JSON 展平为单行，如 `{"names": \n["双环传动"]\n}` → `{"names":["双环传动"]}`；callId 等后续字段行跳过）
function compactArgs(b) {
  const ai = b.findIndex((l) => /^\s*args:/.test(l.text));
  if (ai < 0) return null;
  let t = b[ai].text.replace(/^\s*args:\s*/, '');
  for (let k = ai + 1; k < b.length; k++) {
    const v = b[k].text.trim();
    if (!v || /^callId:/.test(v)) continue;
    t += v;
  }
  return t || null;
}

// 保全文：正文核心内容（用户问题 / AI 回复 / 系统提示 / 反编造拦截等），剥掉 | 分隔与孤立空行，只按 max 截断
function renderFull(b, opt) {
  const rows = [];
  for (const l of b) {
    let s = l.text;
    if (/^\s*$/.test(s) || /^\s*\|\s*$/.test(s)) continue; // 孤立空行 / 纯分隔行省略
    if (/^\s*\|\s*/.test(s)) s = '  ' + s.replace(/^\s*\|\s*/, '').trimEnd();
    rows.push(truncate(s, opt.max, opt.tailRatio).body);
  }
  return rows;
}

function renderRequest(b, st) {
  const f = fieldLines(b);
  const head = `${headClock(b[0].text)} 发起请求`;
  let s = `${head}  requestId=${f.requestId || '?'} 工具数=${f.工具数 || '?'} 消息数=${f.消息数 || '?'}`;
  if (!st.reqFirst) {
    st.reqFirst = true;
    const extra = [
      f.baseUrl && `baseUrl=${f.baseUrl}`, f.stream && `stream=${f.stream}`,
      f['关闭思考'] && `关闭思考=${f['关闭思考']}`, f.模型 && `模型=${f.模型}`,
    ].filter(Boolean);
    if (extra.length) s += `  【固定: ${extra.join(' | ')}】`;
  } else if (f.baseUrl && st.baseUrl && f.baseUrl !== st.baseUrl) {
    s += `  【baseUrl 变化→ ${f.baseUrl}】`;
  }
  st.baseUrl = f.baseUrl || st.baseUrl;
  return [s];
}

function renderResponse(b) {
  const f = fieldLines(b);
  return [`${headClock(b[0].text)} 模型响应  ok=${f.ok || '?'} 中断=${f.中断 || '?'} 工具调用数=${f.工具调用数 || '?'} 思考=${f.思考字符 || '?'} 文本=${f.文本字符 || '?'} 结束=${f.结束原因 || '?'}`];
}

function renderToolCall(b, opt) {
  const name = headType(b[0].text).replace(/^工具调用\s*·\s*/, '').trim();
  const f = fieldLines(b);
  const args = compactArgs(b);
  const cid = f.callId ? `  callId=${f.callId}` : '';
  if (!args) return [`${headClock(b[0].text)} 工具调用 · ${name}${cid}`];
  const t = truncate(args, opt.max, opt.tailRatio);
  return [`${headClock(b[0].text)} 工具调用 · ${name}  args: ${t.body}${cid}`];
}

function renderToolResult(b, st, opt) {
  const name = headType(b[0].text).replace(/^工具返回\s*·\s*/, '').trim();
  const f = fieldLines(b);
  const rows = [`${headClock(b[0].text)} 工具返回 · ${name}  耗时=${f['耗时ms'] || '?'} 失败=${f.失败 || '?'} 返回字符=${f.返回字符 || '?'} 上限=${f.上限 || '?'}`];
  const ri = b.findIndex((l) => /^\s+result:/.test(l.text));
  if (ri >= 0) {
    const rl = b[ri];
    const key = rl.text.replace(/^\s+result:\s*/, '').trim();
    const seen = st.seenResult.get(key);
    if (seen) {
      rows.push(`  result: ⟦与 L${seen} result 完全相同，已省略（原始 ${Array.from(key).length} 字）⟧`);
    } else {
      st.seenResult.set(key, b[0].row);
      rows.push(`  ${truncate(key, opt.max, opt.tailRatio).body}`);
    }
  }
  return rows;
}

function renderError(b, st) {
  const f = fieldLines(b);
  const bodyLine = b.find((l) => /\|\s*\S/.test(l.text));
  const body = bodyLine ? bodyLine.text.replace(/^\s*\|\s*/, '').trim() : '';
  const extra = [
    f['连续重复'] ? `连续重复=${f['连续重复']}` : '',
    f['首次发生'] ? `首次=${f['首次发生']}` : '',
  ].filter(Boolean).join(' ');
  const sig = body || '未知主体';
  let s = `${headClock(b[0].text)} 报错信息 在途=${f['在途请求数'] || '?'} ${extra}`;
  if (st.seenErrSig.has(sig)) s += '  【主体同前，重复】';
  else { st.seenErrSig.set(sig, b[0].row); s += `  ${sig}`; }
  return [s];
}

function renderSession(b, st) {
  const rows = [`${headClock(b[0].text)} 会话事件`];
  for (const l of b.slice(1)) {
    const m = l.text.match(/^(\s{2}[^:]+):\s*(.*)$/);
    if (!m) { if (l.text.trim()) rows.push(l.text); continue; }
    const key = m[1].trim(), val = m[2].trim();
    if (key !== '说明' && st.sessionFields.get(key) === val) rows.push(`  ${key}: ⟦同上次会话⟧`);
    else { rows.push(`  ${m[1]}: ${val}`); st.sessionFields.set(key, val); }
  }
  return rows;
}

function renderLedger(b) {
  const ty = headType(b[0].text);
  const f = fieldLines(b);
  const extra = [
    f['调用次数'] ? `调用次数=${f['调用次数']}` : '',
    f['行情成功'] ? `行情成功=${f['行情成功']}` : '',
  ].filter(Boolean).join(' ');
  const s = `${headClock(b[0].text)} ${ty.trim()}  ${extra}`.replace(/\s+$/, '');
  return [`${s}（明细见上方对应工具调用/返回，已省略）`];
}

function renderSticky(b, st, opt) {
  const ty = headType(b[0].text);
  const rows = [`${headClock(b[0].text)} ${ty.trim()}`];
  let content = null;
  for (const l of b) {
    const m = l.text.match(/^\s{2}(字符|用途|内容):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === '内容') content = m[2].trim();
    else rows.push(`  ${m[1]}: ${m[2].trim()}`);
  }
  if (content) {
    // content 是某 result 的复本/截断版 → 引用省略
    let dup = null, best = 0;
    for (const [key, row] of st.seenResult) {
      const lim = Math.min(key.length, content.length, 300);
      let n = 0;
      while (n < lim && key[n] === content[n]) n++;
      if (n >= 120 && n > best) { best = n; dup = row; }
    }
    if (dup) rows.push(`  content: ⟦为 L${dup} result 的复本（前 ${best} 字一致），已省略⟧`);
    else rows.push(`  content: ${truncate(content, opt.max, opt.tailRatio).body}`);
  }
  return rows;
}

// 紧凑模式主渲染：按事件块折叠输出（--stats-only/--long-only 已在前文提前退出）
function compactRender(lines, opt, startRow = 1) {
  const st = { reqFirst: false, baseUrl: null, seenResult: new Map(), seenErrSig: new Map(), sessionFields: new Map(), replyKey: null, replyAt: 0 };
  const out = [];
  const basePrefix = (row) => `L${String(row).padStart(3, '0')}> `; // 事件块定位前缀（原文件行号）
  const its = lines.map((l, i) => ({ len: l.len, text: l.text, row: startRow + i }));
  let i = 0;
  while (i < its.length) {
    const l = its[i];
    if (!isHead(l.text)) { // 无事件标记的行（文件头等）原样输出
      out.push(`${opt.noPrefix ? '' : basePrefix(l.row)}${truncate(l.text, opt.max, opt.tailRatio).body}`);
      i++; continue;
    }
    let j = i + 1;
    while (j < its.length && !isHead(its[j].text)) j++;
    const b = its.slice(i, j);
    const ty = headType(b[0].text) || '';
    let rows;
    if (!ty) rows = renderFull(b, opt);
    else if (ty.includes('会话事件')) rows = renderSession(b, st);
    else if (ty.includes('发起请求')) rows = renderRequest(b, st);
    else if (ty.includes('模型响应')) rows = renderResponse(b);
    else if (ty.includes('工具调用')) rows = renderToolCall(b, opt);
    else if (ty.includes('工具返回')) rows = renderToolResult(b, st, opt);
    else if (ty.includes('报错信息')) rows = renderError(b, st);
    else if (ty.includes('跨轮工具记录')) rows = renderLedger(b);
    else if (ty.includes('跨轮数据便签')) rows = renderSticky(b, st, opt);
    else if (ty.includes('AI 回复')) { // 与之前回复完全重复 → 引用省略（如 [039] 与 [034] 原样复读）
      const rawKey = b.slice(1).map((l) => l.text).join('\n');
      if (rawKey && st.replyKey === rawKey) rows = [`${headClock(b[0].text)} AI 回复 ⟦与 L${st.replyAt} 回复内容完全重复，已省略⟧`];
      else { st.replyKey = rawKey; st.replyAt = b[0].row; rows = renderFull(b, opt); }
    }
    else rows = renderFull(b, opt); // 用户问题 / AI 回复 / 反编造拦截 / 系统提示等
    const p = opt.noPrefix ? '' : basePrefix(b[0].row);
    const pad = opt.noPrefix ? '' : p.replace(/\S/g, ' '); // 后续行空格对齐，前缀仅块首一次
    rows.forEach((r, k) => out.push(k === 0 ? p + r : pad + r));
    i = j;
  }
  const total = out.reduce((a, s) => a + Array.from(s).length, 0);
  return { text: out.join('\n'), total, count: out.length };
}

// ---------------------------------------------------------------- main
let opt;
try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
if (opt.help) { console.log(helpText()); process.exit(0); }
if (opt.max < 40) { console.error('--max 至少 40，避免截断后失去可读性'); process.exit(2); }

// 定位文件：显式参数 > ./docs/debug.txt > 脚本同级 debug.txt > 脚本 ../docs/debug.txt
const candidates = opt.file
  ? [path.resolve(process.cwd(), opt.file)]
  : [path.resolve(process.cwd(), 'docs', 'debug.txt'),
     path.resolve(__dirname, 'debug.txt'),
     path.resolve(__dirname, '..', 'docs', 'debug.txt')];
const file = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];

let loaded;
try { loaded = loadLines(file); } catch (e) { console.error(`[read-debug] 打不开 ${file}：${e.message}`); process.exit(1); }
const { lines } = loaded;
const bytes = fs.statSync(file).size;

const stats = computeStats(lines, opt.max);
stats.totalLines = lines.length;

printStats(file, bytes, stats, opt.max);

if (opt.statsOnly) { printLongLines(stats, opt.max, opt.tailRatio); console.log(BAR); process.exit(0); }
if (opt.longOnly) { printLongLines(stats, opt.max, opt.tailRatio); console.log(BAR); process.exit(0); }
printLongLines(stats, opt.max, opt.tailRatio);

// ---- 正文 ----
console.log('');
let startIdx = opt.tail ? Math.max(0, lines.length - opt.tail) : 0;
let endIdx = opt.limit ? Math.min(lines.length, opt.limit) : lines.length;
if (!opt.full && (opt.limit || opt.tail) && lines.some((l) => isHead(l.text))) {
  // 紧凑模式将切片吸附到事件块边界，避免从块中间切开（逐行模式不吸附）
  // 吸附切片起点到最近的 head 行（块首），避免从块中间切开
  if (startIdx > 0 && !isHead(lines[startIdx].text)) {
    let pos = startIdx;
    while (pos > 0 && !isHead(lines[pos - 1].text)) pos--;
    if (pos > 0) pos--;
    startIdx = pos;
  }
  while (endIdx < lines.length && !isHead(lines[endIdx].text)) endIdx++;
}
const sliced = lines.slice(startIdx, endIdx);

if (!opt.full) {
  const comp = compactRender(sliced, opt, startIdx + 1);
  const saved = stats.totalChars - comp.total;
  const pct = ((saved / stats.totalChars) * 100).toFixed(1);
  console.log(`正文（紧凑模式 · 原始 ${stats.totalChars} 字 → 输出 ${comp.total} 字，省 ${pct}% · ${comp.count} 行；--full 看逐行版）:`);
  console.log(comp.text);
  if (opt.limit || opt.tail) {
    const shown = endIdx - startIdx;
    const where = opt.tail ? `末尾 ${shown} 行` : `前 ${shown} 行`;
    console.log(`  …（以上仅 ${where}，全文 ${lines.length} 行）`);
  }
} else {
  console.log(`正文（逐行版 · 共 ${lines.length} 行 · 每行上限 ${opt.max} 字，超长已截断）:`);
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i];
    const { body } = truncate(line.text, opt.max, opt.tailRatio);
    const gap = (line.text.trim() === '') ? '-' : ' ';
    const prefix = opt.noPrefix ? '' : `L${String(i + 1).padStart(3, '0')}·${line.len}字${gap}`;
    console.log(`${prefix}${body}`);
  }
  if (opt.limit || opt.tail) {
    const shown = endIdx - startIdx;
    const where = opt.tail ? `末尾 ${shown} 行` : `前 ${shown} 行`;
    console.log(`  …（以上仅 ${where}，全文 ${lines.length} 行；看别处请用 --tail/--limit/--long-only/--stats-only）`);
  }
}
console.log(BAR);
