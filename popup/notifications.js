import { calcImportPercent, numOrNull } from '../shared/utils.js';

// 系统通知：type 区分当日 / 导入以来
export function createChromeNotification(stock, type, percentValue) {
    const label = type === 'import' ? '导入以来涨跌幅' : '当日涨跌幅';
    const direction = percentValue > 0 ? '涨幅' : '跌幅';
    chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon.png'),
        title: '股价已达预定值',
        message: `【${stock.name}】${label}${direction}已达到${percentValue}%`,
        priority: 2
    });
}

// 双阈值锁存通知（当日 + 导入以来独立）：越界通知一次，回区间复位
export function applyThresholds(stock) {
    const percent = numOrNull(stock.percent);
    if (percent !== null) {
        const dailyHit = (stock.targetPercentLe && percent <= parseFloat(stock.targetPercentLe))
            || (stock.targetPercentGe && percent >= parseFloat(stock.targetPercentGe));
        if (dailyHit) {
            if (!stock.notifiedDaily) {
                stock.notifiedDaily = true;
                createChromeNotification(stock, 'daily', percent);
            }
        } else {
            stock.notifiedDaily = false;
        }
    }
    const importPercent = calcImportPercent(stock.currentPrice, stock.importPrice);
    const importHit = importPercent !== null && (
        (stock.importTargetPercentLe && importPercent <= parseFloat(stock.importTargetPercentLe))
        || (stock.importTargetPercentGe && importPercent >= parseFloat(stock.importTargetPercentGe)));
    if (importHit) {
        if (!stock.notifiedImport) {
            stock.notifiedImport = true;
            createChromeNotification(stock, 'import', importPercent);
        }
    } else {
        stock.notifiedImport = false;
    }
}
