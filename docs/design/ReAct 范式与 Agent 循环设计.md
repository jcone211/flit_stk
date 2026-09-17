> **STATUS: 设计解析（2026-09-06）** 描述性文档，文内行号为参考，以代码为准。
# ReAct 范式与 Agent 循环设计

> 分析日期：2026-09-06
> 说明：本文详细拆解 flit_stk 项目中 AI Agent 的 ReAct(Reasoning + Acting)范式实现，包括核心循环架构、三要素落地方案、六种终止路径以及相关安全机制。

---

## 一、什么是 ReAct 范式

ReAct(Reasoning + Acting)是一种将推理(Reasoning)与行动(Acting)交织进行的智能体范式。其核心思想是：模型在每一轮中推理当前情况、决定下一步行动、观察执行结果、再推理——形成思考->行动->观察->再思考的闭环，直到任务完成。

传统 LLM 的 function calling 只是线性流程。**ReAct 将其升级为循环**——模型可以在一次用户提问内反复调工具、分析结果、再调工具。

flit_stk 的 AI Agent 自称基于 **ReAct 范式**，零依赖 function-calling 循环，全套实现位于 ai/ai.js + ai/core/ai_tools.js，**不依赖任何第三方 Agent 框架**。

## 二、核心循环架构

### 2.1 总体数据流

```
用户输入 -> handleSend()
  |
runAgentLoop()
  +-> runAgentLoopBody()
  |   +-- [每轮] buildSystemPrompt() 注入上下文
  |   +-- [每轮] sendRound(流式) LLM 推理+决策
  |   +-- 有 tool_calls？ -> executeToolCalls() -> inject -> continue
  |   +-- 无 tool_calls -> guard 审核 -> commitAssistant() -> return
  |   +-- 请求失败？ -> 重试 -> 仍失败 -> return
  |   +-- 达上限？ -> 提示 -> return
  |
finally: pushToolTrace + pushRetainedNotes
```

### 2.2 runAgentLoop 外层

try/finally 保证**任何退出路径(含抛异常)都落账本和便签**。

### 2.3 runAgentLoopBody 循环体

伪代码：
```
for (round = 0; round < maxToolIterations; round++) {
    evictToolResults();
    requestMessages = [buildSystemPrompt(), ...apiMessages];
    tools = [TOOL_GROUP_DEF, ...CONTEXT_TOOL_DEFS, ...getLoadedToolDefs()];
    result = await sendRound(requestMessages, tools, { stream: true });

    if (result.aborted) { appendMessage(已停止); return; }
    if (!result.ok) { /* 重试 */ return; }

    if (result.tool_calls) {
        apiMessages.push(...await executeToolCalls(sanitizedCalls, turnCalls));
        continue;
    }

    // guard 审核
    decision = decideQuoteGuard({ text, topicIsQuote, refusal, retried });
    if (decision.action === drop) { dropAssistantBubble(); appendMessage(error); return; }
    commitAssistant(result.content);
    if (result.finish_reason === length) appendActionButton(继续生成);
    return;
}
appendMessage(system, 已达上限);
```

### 2.4 关键常量

| 常量 | 默认值 | 说明 |
|:---|:---|:---|
| DEFAULT_MAX_TOOL_ITERATIONS | 50 | 单次提问内最大 ReAct 轮数 |
| MAX_MESSAGES | 100 | 聊天消息总条数上限 |
| MAX_MESSAGE_CHARS | 10000 | 单条消息字符上限 |
| MAX_TOOL_RESULT_CHARS | 20000 | 工具结果全局硬顶 |
| MAX_ROUND_TOOL_CHARS | 16000 | 单轮工具结果总预算 |
| REQUEST_IDLE_TIMEOUT_MS | 45000 | 滑动空闲超时 |
| REQUEST_MAX_TIMEOUT_MS | 300000 | 请求最长等待 |
| KEEPALIVE_INTERVAL_MS | 20000 | Service Worker 保活 ping |


## 三、ReAct 三要素的具体实现

### 3.1 Reasoning(推理)

#### 3.1.1 buildSystemPrompt 动态系统提示

每轮循环开始前构建完整推理上下文，不是静态模板而是**每轮动态拼接**：
- [当前时间]：时间+星期+A股时段+盘中/盘后判定
- [工具组]：一行摘要目录
- [桥接硬约束]：安全红线
- [强制取数]：行情数值必须来自真实工具调用
- [取数纪律]：同批同类查询只调一次
- [数据时效]：末行带 intraday 才可称现价
- 工作目录指南 + 工具规则 + 长期记忆

#### 3.1.2 思考过程折叠展示

支持思考型模型(如 DeepSeek-R1)的长推理：
- beginThinking() 创建灰色折叠块
- appendToCurrentThinking(delta) 实时刷新推理文本尾部
- finishThinking() 正文到达后折叠归档

模型可能先花 10~30s 只输出 reasoning_content。实时展示尾部文本(THINKING_TAIL_CHARS=1200)，避免页面空转。

#### 3.1.3 跨轮推理上下文管理

tool 原始返回**只在当轮 function-calling 循环内有效**。跨轮靠两种隐藏上下文条目：

| 条目 | 触发 | 内容 | 容量 |
|:---|:---|:---|:---|
| tool_trace 账本 | 每轮自动落 | 工具名、参数、耗时、成功/失败 | 单条 900 字，留最近 2 轮 |
| retained_data 便签 | 模型主动调 retain_tool_data | 工具真实返回原文 | 单条 3000 字，最多 3 条，总量 6000 字 |

两者均以 role: user 回灌，走线前剥掉内部字段。

#### 3.1.4 反编造 Guard 审核

在模型输出正文到达用户前做最后一次推理裁决：
- pass：正常提交
- note：提交 + 灰字说明工具拒绝原因
- correct：注入强制纠正，再来一轮
- drop：丢弃正文(工具已拒绝仍编数字)
- pass_warn：放行 + 免责提示(弱信号二次命中)

#### 3.1.5 工具组冷加载

初始请求只发 load_tool_group(元工具)。模型推理需要什么能力再申请加载。
常驻工具仅 2 个：load_tool_group + retain_tool_data。

### 3.2 Acting(行动)

工具执行引擎 executeToolCalls：
1. 解析参数
2. toolExecutors[name]() 执行
3. 结果按 TOOL_RESULT_CHARS 截断
4. renderToolEntry 渲染
5. 注入 apiMessages

串行执行，单轮预算 MAX_ROUND_TOOL_CHARS=16000。

### 3.3 Observation(观察)

tool 消息直接注入 apiMessages，下一轮 sendRound 时模型可见所有执行结果。
渲染折叠条目标注截断状态和失败原因。DEBUG 日志记录每个请求和 guard 决策。

---

## 四、六种终止路径

| # | 路径 | 触发条件 | 结果 |
|:---|:---|:---|:---|
| 1 | 正常完成 | LLM 无 tool_calls，guard 通过 | commitAssistant() 落库 |
| 2 | 达上限兜底 | 循环自然结束 | 系统提示 |
| 3 | 用户停止 | 点击停止按钮 | 保留已生成部分 |
| 4 | 请求失败 | 网络断开/API 错误 | 报错+重试按钮 |
| 5 | 安全拦截 | guard 返回 drop | 删除气泡+报错 |
| 6 | 继续生成 | finish_reason===length | 挂按钮，点击重启循环 |

路径 1 是唯一让模型输出可见正文的路径。

---

## 五、独特强化

- 工具组冷加载：先送目录，按需加载，常驻仅 2 工具
- 反编造 Guard：在推理→行动间插入安全审核层
- 跨轮上下文：隐藏条目以 role:user 回灌
- 流式推理展示：reasoning_content 实时折叠块
- 空闲超时+保活：45s+300s+20s ping

## 六、文件索引

| 功能 | 文件 | 行号 |
|:---|:---|:---|
| runAgentLoop | ai/ai.js | L336-473 |
| executeToolCalls | ai/ai.js | L654-L704 |
| guard 三态决策 | ai/core/ai_guard.js | L69-L82 |
| 工具定义/分组 | ai/core/ai_tools.js | L32-L92 |
| buildSystemPrompt | ai/core/ai_tools.js | L1830-L1859 |
| 工具执行器 | ai/core/ai_tools.js | L164-L922 |
| retain_tool_data | ai/core/ai_tools.js | L929-L960 |
| 思考过程展示 | ai/ai.js | L1230-L1270 |
| tool_trace 账本 | ai/ai.js | L542-L556 |
| 常量定义 | ai/core/ai_state.js | L11-L77 |
| 回归测试 | scripts/verify/verify-free-first.mjs | C9/C10/G1/R1 |

## 七、回归验证

scripts/verify/verify-free-first.mjs 含 167 项断言覆盖 ReAct 核心链路：
C9 系统提示、C10 工具完整性、G1-G2 guard 决策、R1 跨轮便签安全

## 八、总结

flit_stk 的 AI Agent 是完整 ReAct 循环——模型每轮推理→行动→观察→再推理，直到给出回答。
零依赖第三方框架，完全在扩展本地实现，并强化了冷加载、Guard、隐藏上下文、流式展示等能力。
