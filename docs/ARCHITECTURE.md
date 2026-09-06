# 架构设计

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│ Clients（Web 控制台 / Android / iOS）                         │
├─────────────────────────────────────────────────────────────┤
│ 协议层 OPS/1.0（REST :3001 + WebSocket :3002）                │
├─────────────────────────────────────────────────────────────┤
│ Core（平台无关，禁止 import 任何平台 API）                     │
│   PrinterRegistry / JobManager / VirtualPrintEngine /        │
│   EventLog / EventBus / FileStorage / Pairing / Discovery /  │
│   SettingsStore / SelfTestRunner                             │
├─────────────────────────────────────────────────────────────┤
│ Printer Backend（可插拔：Mock ★ / Windows / CUPS / ...）      │
├─────────────────────────────────────────────────────────────┤
│ Platform Adapter（Windows / macOS / Linux / Android / iOS）  │
└─────────────────────────────────────────────────────────────┘
```

**核心原则**

1. `src/core/` 下的模块只使用标准库（node:fs / node:http / node:crypto / node:events），不感知平台。
2. 平台差异通过 `PlatformAdapter` 与 `PrinterBackend` 两个接口注入（依赖倒置）。
3. `HostContext`（src/host.ts）是唯一装配点：构造各模块并互相注入，避免循环依赖。
4. 事件驱动：领域事件经 `EventBus` 广播 → WS 层转发给客户端 → `events.jsonl` 落盘审计。

## Core 模块职责

| 模块 | 职责 |
|---|---|
| `core/types.ts` | 领域类型（Printer/PrintJob/PrintOptions/事件/测试），纯类型无运行时依赖 |
| `core/storage.ts` | 文件型 Storage（原子写：唯一 tmp 名 + rename），jobs/printers/settings/devices/pairing/events/test-runs |
| `core/printers.ts` | 打印机注册表：种子虚拟打印机、创建/更新/删除/共享开关、状态变更（touch/persistThrottled 节流写盘） |
| `core/jobs.ts` | 任务数据 + FIFO 队列 + 状态机时间线 + 工件落盘（document.pdf/job.json/result.json） |
| `core/engine.ts` | VirtualPrintEngine：250ms tick 推进、里程碑、墨耗、条件注入/修复/恢复、Host 重启恢复 |
| `core/eventlog.ts` | 内存环形缓冲 + jsonl 追加 + 事件广播 |
| `core/pairing.ts` | 配对请求/审批/令牌/撤销；open/pairing 双安全模式 |
| `core/discovery.ts` | UDP Beacon 广播（44445 端口）+ 公告注册表；生产替换为 Bonjour/Avahi |
| `tests/selftest.ts` + `scenarios.ts` | 内置自动化测试运行器（产品化能力） |

## 打印任务状态机

```
pending ──▶ processing ──▶ completed
   │            │  ▲
   │            ▼  │ (Resume / Set Online 自动续打)
   │          paused ──(Fail)──▶ failed ◀── (Printer Error)
   └────────────▶ cancelled ◀──── (Cancel)
   failed/cancelled ──(Retry)──▶ pending
```

- 暂停原因（`paused.reason`）：`offline` / `paper-out` / `paper-jam` / `error` / `host-restart`
- 进度跨暂停连续：恢复后从原进度继续（不清零）
- 每次状态/里程碑变化写入 `job.timeline` 并持久化；processing 期间每 500ms 落盘一次（重启可恢复进度）

## 打印机状态模型

```
online（就绪）⇄ busy（打印中）
   │  Set Offline / Paper Out / Paper Jam / Error
   ▼
offline / paper-out / paper-jam / error（条件态）
   │  Set Online（自动续打）/ 补纸 / 清卡 + Resume
   ▶ online
```

- 低墨（≤15%）为预警不阻塞；墨尽（=0）转 `error` 并暂停任务，加墨后可恢复
- 引擎调度规则：`无 active 任务 && status=online` → 取队首 pending 开始；`active 任务 processing && status=busy` → 推进

## 热重载与重启语义

- 开发模式使用 `bun --watch`（进程级自动重启；有状态服务不适合 `--hot` 模块热替换）
- **Host 重启（真实或 `/api/debug/restart` 模拟）**：从磁盘重建内存状态：
  - `processing` 任务 → 恢复为 processing（保留进度，时间线记录 host-restart）并自动续打
  - `paused`/`pending` → 原样恢复等待
  - 打印机条件（paper-out 等）持久保留；无 active 任务的 busy 归一化为 online

## 阶段 10：接入真实打印机

`PrinterBackend` 接口（src/backends/index.ts）已定义：

```ts
interface PrinterBackend {
  kind: BackendKind
  available(): Promise<boolean>          // 当前环境是否可用
  readonly availabilityNote: string
  listSystemPrinters(): Promise<SystemPrinterDescriptor[]>  // 导入系统打印机
}
```

- **WindowsPrinterBackend**：`Get-Printer` 枚举 → 导入 OPS Printer；提交用 Print Spooler（`Add-Job` / RAW pass-through），任务进度查询映射到 `JOB_INFO` 状态
- **CupsPrinterBackend**（macOS/Linux）：CUPS IPP `get-printers` 枚举；`print-job` 操作提交 PDF（PDF 是 CUPS 原生支持格式，无需厂商驱动）；任务状态查询映射 IPP job-state
- 替换后 Core/协议/队列/UI 不变；VirtualPrintEngine 退役为开发/测试后端（可共存，`backend` 字段区分）
