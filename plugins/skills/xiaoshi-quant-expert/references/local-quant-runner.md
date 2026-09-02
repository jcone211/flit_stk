# 小石本地量化执行引擎 / Xiaoshi Local Quant Runner

## 1. 简介
小石本地量化执行引擎（Local Quant Runner）是小石大数据 API 平台的客户端核心回测工具。它支持将小石 API 提供的数据批量缓存到本地 Parquet 文件中，并由本地 Python 执行快速、精确、防未来的历史回测。所有计算均在用户本地完成，服务器不代跑回测，以消除服务器计算压力并保障用户策略的私密性。

## 2. CLI 命令行操作
通过 `python -m tools.xiaoshi_quant_runner.cli` 可以调用命令行工具。

### 数据下载命令
```bash
python -m tools.xiaoshi_quant_runner.cli download --api-key <YOUR_API_KEY> --codes 600519,000001 --since 2026-01-01 --to 2026-07-15
```
- `--api-key`: 可选；也可通过 `XIAOSHI_API_KEY` 环境变量提供，避免密钥进入命令历史。
- `--codes`: 必填。以逗号分隔的股票代码列表。
- `--period`: 行情周期（默认 `daily`）。
- `--adjust`: 复权口径（默认 `qfq`，支持 `none`, `qfq`, `hfq`）。
- `--since` / `--to`: 数据的时间起始区间（`YYYY-MM-DD`）。
- 该命令会自动同步下载指定股票的 K 线数据，以及对应的 PIT 财务披露、基本面快照和巨潮公告。

### 本地回测命令
策略文件必须导出继承 `StrategyBase` 的 `Strategy` 类，或导出 `strategy` 实例：
```bash
python -m tools.xiaoshi_quant_runner.cli backtest \
  --strategy ./my_strategy.py --data-dir ./xiaoshi_data \
  --codes 600519,000001 --start 2020-01-01 --end 2025-12-31 \
  --adjust qfq --benchmark 000300 --output-dir ./backtest_output
```
该命令会真实运行本地回测并生成报告，不会向小石服务器提交策略或计算任务。盘前信号按当日开盘模拟，收盘及盘后信号最早按下一可交易日开盘模拟；回测末尾尚未到下一根 K 线的信号保留为 `pending_signals`，不得伪造成交。

### 环境状态检测命令
```bash
python -m tools.xiaoshi_quant_runner.cli status
```
- 输出当前量化引擎的版本号、是否开启了 OSkhQuant 非商业开关以及本地 xtquant/MiniQMT 库的安装状态。

### 历史增量同步命令
```bash
python -m tools.xiaoshi_quant_runner sync-history --data-dir ./xiaoshi_data
```
- 从 `XIAOSHI_API_KEY` 读取密钥，调用官方 manifest 与 2 小时 R2 下载地址。
- 对比 `size` 和 `sha256` 后只下载变化文件，校验通过再原子替换。
- 不再使用已经退役的公开镜像或固定节点地址。

### 策略研究包命令
先把研究目标保存为 `research-request.json`，字段包括 `strategy_name`、`markets`、`since`、`to`、`frequency`、`adjust` 和可选 `codes`，再运行：
```bash
python -m tools.xiaoshi_quant_runner research-package \
  --request ./research-request.json --data-dir ./xiaoshi_research
```
- 服务端只生成市场/年份或市场/月级 R2 清单，不逐股票查询，也不代跑策略。
- 客户端直接下载两小时 R2 地址，逐文件校验 `size` 与 `sha256` 后原子落盘。
- `codes` 只作为本地筛选范围；行情、事件、未来概率和板块证据均按 PIT 时间在本地连接。
- 下载后先运行 `validate-data`，再用 `backtest` 执行策略和生成可复现报告。

### 数据与因子质量检查
本地验证器按“股票代码 + 时间”检查重复键，并检查缺失值、时间范围、复权口径、可用时间与文件校验和。截面因子研究使用按日期划分的训练/测试集，输出每日 IC/RankIC、月度 ICIR、分组收益、换手率和可用时间泄漏检查；不能把多只股票同一天的正常截面误判成重复记录。

## 3. 回测产物说明
每次本地回测执行完毕后，引擎将在指定的输出目录（默认 `./backtest_output`）中生成完整的标准化报告包：
- `run_manifest.json`: 回测运行清单。包含随机种子、时间范围、复权口径、费用配置、执行参数、数据源说明以及所有本地输入数据的 SHA256 哈希，用以精确复现。
- `summary.json`: 包含年化收益率、夏普比率、最大回撤、索提诺比率、回撤恢复期和交易笔数等。
- `signals.csv`: 策略产生的所有原始信号记录。
- `orders.csv`: 委托意向列表，包含报价和买卖方向。
- `trades.csv`: 详细的成交历史，包含成交时间、价格、股数以及每笔扣减的手续费与滑点成本。
- `positions.csv`: 每日收盘后的详细持仓列表。
- `equity.csv`: 每日收盘后的账户总资产与现金曲线。
- `report.html`: 交互式可视化报告网页，使用 Chart.js 展示策略/真实基准净值、回撤、仓位比例和现金曲线。
