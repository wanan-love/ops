# MockPrinterBackend / Virtual Printer 设计

## 目标

在没有真实打印机的开发环境（本沙箱/CI）中完整运行、演示和自动化测试整个打印系统。

## 组成

- **`src/backends/index.ts` → `MockPrinterBackend`**：实现 `PrinterBackend` 接口，`available() === true`；虚拟打印机实体由 `PrinterRegistry` 管理
- **`src/core/engine.ts` → `VirtualPrintEngine`**：模拟引擎（本后端的执行核心）
- 种子虚拟打印机：彩色激光（12ppm/双面/彩色）、单色喷墨（6ppm/单面/黑白）、未共享小票机（演示共享开关）

## 引擎机制

- **tick 循环**：250ms/次，逐打印机调度
  - `无 active && online` → 取队首 pending 开始（printer → busy）
  - `active processing && busy` → 按 ppm 推进进度
- **进度**：`sheetsTotal = ceil(pageCount × copies / (duplex?2:1))`；跨 25/50/75/100 里程碑写时间线
- **墨耗模拟**：彩色 C/M/Y 各 0.5%/张 + K 0.9%/张；黑白 K 1.8%/张；质量系数 draft 0.7 / normal 1 / high 1.4
  - ≤15% 低墨预警（事件 + 任务时间线）；=0 转 `error` 并暂停任务，加墨可恢复
- **速度**：`speedOverridePpm`（1–600，调试滑杆）覆盖标称 ppm

## 状态注入（Debug 控制台按钮 → REST）

| 按钮 | 端点 | 行为 |
|---|---|---|
| Set Online | `condition {condition: online}` | 清除任何条件；离线暂停的任务**自动续打** |
| Set Offline | `condition {condition: offline}` | 打印中任务 → paused(reason=offline)；pending 任务登记"等待恢复" |
| Paper Out | `condition {condition: paper-out}` | 打印中任务 → paused(reason=paper-out) |
| Paper Jam | `condition {condition: paper-jam}` | 打印中任务 → paused(reason=paper-jam) |
| Printer Error | `condition {condition: error}` | 打印机转错误态 |
| 补纸 | `fix {action: add-paper}` | 修复缺纸（任务保持 paused 等待 Resume） |
| 清除卡纸 | `fix {action: clear-jam}` | 修复卡纸（同上） |
| Resume | `resume` | 恢复暂停任务；条件未清则返回 409 |
| Fail Current Job | `mock/jobs/{id}/fail` | 当前任务 → failed（写入 error 消息）+ 打印机 → error |
| Cancel Current Job | `jobs/{id}/cancel` | 当前任务 → cancelled，队列下一任务自动开始 |
| 加墨 | `mock/printers/{id}/ink` | CMYK → 100%，解除墨尽错误 |
| 重置 | `mock/printers/{id}/reset` | 取消任务 + 清条件 + 满墨 + 恢复标称速度 |

## 五大场景时序（与需求一一对应）

```
正常打印   PDF → 0% → 25% → 50% → 75% → 100% → Completed
打印机离线 Job → Queued → Printer Offline → 等待恢复 → Printer Online → 继续打印 → Completed
缺纸       Job → Printing → Paper Out → 暂停 → 补纸 → Resume → Completed
卡纸       Job → Printing → Paper Jam → Paused → Clear Jam → Resume → Completed
打印失败   Job → Printing → Printer Error → Failed
取消       Job → Queued/Printing → Cancel → Cancelled
```

## 工件落盘（`./data/mock-printer/`）

每个任务一个目录：`document.pdf`（原始 PDF）、`job.json`（PrintJob + PrintOptions + 时间线）、`result.json`（模拟打印结果：outcome/耗时/张数/墨耗）。全局 `events.jsonl` 记录状态变化；`test-runs/*.json` 存放测试报告。

## 自动化测试（Self-Test）

**产品化能力**（非外部测试代码）：`POST /api/tests/run` 触发，Web 控制台「调试控制台」可视化运行，进度经 WS `test:progress` 实时推送。

| 场景 | id | 断言要点 |
|---|---|---|
| 正常打印 | `normal-print` | progress=100、时间线含 25/50/75/100、三件工件存在 |
| 离线等待 | `offline-waiting` | 离线时 pending 保持、时间线记录等待、上线后完成 |
| 离线续打 | `offline-resume` | 打印中暂停（进度保持）→ 上线自动续打 → 完成、进度连续 |
| 缺纸 | `paper-out` | paused → 补纸仍 paused → Resume → 完成 |
| 卡纸 | `paper-jam` | paused → 清卡仍 paused → Resume → 完成 |
| 打印失败 | `print-failure` | failed + error 消息 + 打印机 error → Set Online 恢复 |
| 取消任务 | `cancel-job` | cancelled + 队列下一任务自动开始并完成 |
| 多任务排队 | `multi-queue` | 同时最多 1 个在打（采样验证）、完成顺序 FIFO |
| 并发任务 | `concurrent-jobs` | 两台打印机同时 processing、双双完成 |
| Host 重启 | `host-restart` | 进度从磁盘恢复（≥重启前）、时间线含 host-restart、续打完成 |

## 切换真实打印机

`WindowsPrinterBackend` / `CupsPrinterBackend` 实现同一 `PrinterBackend` 接口后，Host 启动时按平台选择后端即可；Core、协议、队列、UI 与 Mock 时代完全一致（VirtualPrintEngine 保留用于开发/CI）。
