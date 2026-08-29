// cron 表达式解析与下次触发时间计算（5 字段：分 时 日 月 周）
// 支持语法：*、*/n、a-b、a-b/n、a,b,c；周 0-7（0 与 7 均为周日）
// 日/周字段：两者均为 *（不限制）时每天；只有一个为 * 时按另一个判定；
// 同时指定（如 0 9 1 * 1）时需同时满足（cronie/quartz 语义，比经典 OR 更符合直觉）
// 供 background 排程一次性 alarm 使用，popup 侧仅用于表达式校验

// 解析单个字段为合法值集合，非法返回 null
function parseCronField(field, min, max) {
    const values = new Set();
    for (const part of String(field).split(',')) {
        const p = part.trim();
        if (!p) return null;
        if (p === '*') { // 全部值
            for (let v = min; v <= max; v++) values.add(v);
            continue;
        }
        const stepMatch = p.match(/^\*\/(\d+)$/);
        if (stepMatch) {
            const step = parseInt(stepMatch[1], 10);
            if (step < 1) return null;
            for (let v = min; v <= max; v += step) values.add(v);
            continue;
        }
        const rangeMatch = p.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
        if (rangeMatch) {
            const a = parseInt(rangeMatch[1], 10);
            const b = parseInt(rangeMatch[2], 10);
            const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
            if (a < min || b > max || a > b || step < 1) return null;
            for (let v = a; v <= b; v += step) values.add(v);
            continue;
        }
        const n = Number(p);
        if (!Number.isInteger(n) || n < min || n > max) return null;
        values.add(n);
    }
    return values;
}

// 解析完整 cron 表达式，返回 { mins, hours, doms, months, dows } 或 null
export function parseCronExpr(expr) {
    if (typeof expr !== 'string') return null;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const mins = parseCronField(parts[0], 0, 59);
    const hours = parseCronField(parts[1], 0, 23);
    const doms = parseCronField(parts[2], 1, 31);
    const months = parseCronField(parts[3], 1, 12);
    const dows = parseCronField(parts[4], 0, 7);
    if (!mins || !hours || !doms || !months || !dows) return null;
    if (dows.has(7)) { // 周 7 归一为 0（周日）
        dows.delete(7);
        dows.add(0);
    }
    return { mins, hours, doms, months, dows };
}

// 表达式是否合法（popup 设置校验用）
export function validateCronExpr(expr) {
    return parseCronExpr(expr) !== null;
}

// 判断是否处于 A 股交易时段；仅限制时钟，不判断周末和法定节假日
export function isTradingTime(date = new Date()) {
    const minutes = date.getHours() * 60 + date.getMinutes();
    return (minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30)
        || (minutes >= 13 * 60 && minutes <= 15 * 60);
}

// 返回从 fromMs 之后符合 Cron 且处于交易时间的未来触发时间
export function nextTradingCronTimes(expr, fromMs = Date.now(), count = 5) {
    const results = [];
    const limit = Math.max(0, Math.min(Number(count) || 0, 20));
    let cursor = fromMs;
    while (results.length < limit) {
        const next = nextCronTime(expr, cursor);
        if (next === null) break;
        if (isTradingTime(new Date(next))) results.push(next);
        cursor = next;
    }
    return results;
}

// 判断某字段是否覆盖全部值（等价于 *）
function isFullField(values, count) {
    return values.size === count;
}

// 计算 fromMs 之后的下一次触发时间（毫秒）；一年内无法满足（如 2月30日）返回 null
export function nextCronTime(expr, fromMs) {
    const p = parseCronExpr(expr);
    if (!p) return null;
    const domStar = isFullField(p.doms, 31);
    const dowStar = isFullField(p.dows, 7);
    const t = new Date(fromMs);
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1); // 从下一分钟开始，避免立即重复触发
    const end = t.getTime() + 366 * 24 * 60 * 60 * 1000;
    while (t.getTime() < end) {
        const domMatch = p.doms.has(t.getDate());
        const dowMatch = p.dows.has(t.getDay());
        let dayMatch;
        if (domStar && dowStar) dayMatch = true;
        else if (domStar) dayMatch = dowMatch;
        else if (dowStar) dayMatch = domMatch;
        else dayMatch = domMatch && dowMatch; // 同时指定：需同时满足
        if (p.months.has(t.getMonth() + 1)
            && p.hours.has(t.getHours())
            && p.mins.has(t.getMinutes())
            && dayMatch) {
            return t.getTime();
        }
        t.setMinutes(t.getMinutes() + 1);
    }
    return null;
}
