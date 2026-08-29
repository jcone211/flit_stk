if (!window.__thswcContentInjected) {
    window.__thswcContentInjected = true;

    let debounceTimer;
    let lastCaptureAt = 0;
    let observer = null;
    let invalidated = false;

    // 诊断日志开关：排查完成后置 false 可停止逐次抓取刷屏
    const DEBUG = true;

    // 扩展重载/更新后，已注入的旧 content script 运行上下文失效：
    // 此时 chrome.runtime / sendMessage 仍存在，但调用即抛
    // "Extension context invalidated"。正确判据是 chrome.runtime.id（失效时为 undefined）。
    function isContextValid() {
        return !!(chrome.runtime && chrome.runtime.id);
    }

    // 上下文失效后拆除监听、停止重试，避免 MutationObserver 反复触发刷屏报错
    function teardown() {
        invalidated = true;
        clearTimeout(debounceTimer);
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    //校验+防抖
    function captureVerify() {
        if (invalidated || !isContextValid()) {
            teardown();
            return;
        }
        if (document.readyState !== 'complete') return;

        const now = Date.now();
        if (now - lastCaptureAt < 3000) return;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            lastCaptureAt = Date.now();
            captureDocument();
        }, 1000); // 增加延迟确保页面完全加载
    }

    function captureDocument() {
        if (!isContextValid()) {
            teardown();
            return;
        }

        const message = {
            type: 'DOCUMENT_CAPTURED',
            documentData: {
                title: document.title,
                url: window.location.href,
                html: document.documentElement.outerHTML,
                timestamp: Date.now()
            }
        };

        if (DEBUG) console.log('[thswc:content] 已抓取:', message.documentData.url);

        try {
            chrome.runtime.sendMessage(message);
        } catch (err) {
            // 调用时才暴露的失效：静默拆除，重载扩展后刷新页面即可恢复
            console.warn('thswc 抓取脚本上下文已失效，已停止抓取（重载扩展后请刷新该页面）');
            teardown();
        }
    }

    // 初始抓取
    // if (document.readyState === 'complete') {
    //     captureDocument();
    // } else {
    //     window.addEventListener('load', captureDocument);
    // }

    // 监听动态新增元素
    observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                captureVerify();
                break;
            }
        }
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('beforeunload', () => {
        if (observer) observer.disconnect();
    });

    captureVerify();
}
