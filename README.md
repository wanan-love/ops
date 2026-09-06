# OpenPrintShare (OPS)

> 跨平台局域网共享打印机 — 设备 A 安装 Host 共享系统打印机，Windows / macOS / Linux / Android / iOS 设备自动发现并打印。

[![Release](https://img.shields.io/badge/release-v0.1.0--mvp-emerald)](../../releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](#license)
[![Backend](https://img.shields.io/badge/print%20backend-MockPrinterBackend%20(Virtual%20Printer)-amber)](docs/MOCK_PRINTER.md)
[![Self-Test](https://img.shields.io/badge/self--test-10%2F10%20scenarios%20passing-brightgreen)](docs/MOCK_PRINTER.md#自动化测试self-test)

## 项目目标

```
Client(发现 Host) → 浏览共享打印机 → 提交 PDF
      → Host(ops-host 守护进程) → 系统原生打印(A 已安装驱动) → 打印机
```

- **优先兼容操作系统原生打印能力**：CUPS / IPP / IPP Everywhere / Bonjour(mDNS/DNS-SD) / Windows Print Spooler / Android Print Framework / AirPrint
- **客户端尽量无需安装厂商驱动**，实际打印使用 Host（设备 A）上已安装的系统打印机与驱动
- **没有真实打印机也能完整运行**：内置 `MockPrinterBackend`（Virtual Printer），可模拟全部打印状态与故障
- 切换真实打印机时，仅替换 Printer Backend，**Core / 协议 / 队列 / UI 零改动**

## MVP 功能（本仓库 v0.1.0）

| 能力 | 说明 |
|---|---|
| 局域网自动发现 | Host UDP Beacon（生产：Bonjour/Avahi `_ops._tcp`）+ HTTP 发现 + 手动 IP/端口添加 |
| Host / Client | `ops-host` 守护进程（REST + WebSocket）+ Web 控制台（Client + Host 控制台 + 调试台） |
| 共享/取消共享打印机 | 一键开关，客户端实时可见性同步 |
| 打印机状态 | online / busy / offline / paper-out / paper-jam / error + 低墨预警 + CMYK 墨量 |
| 打印任务/队列 | FIFO 队列、实时进度（25/50/75/100 里程碑）、状态时间线、取消/重试 |
| PDF 打印 | 拖放上传、A4/Letter 等纸型、彩色/黑白、单双面、份数、质量、页面范围 |
| 基础设备配对 | 开放模式（默认）/ 配对模式（设备令牌 X-OPS-Token） |
| Virtual Printer | 无物理设备模拟完整打印流程，支持 10 种状态注入 |
| 自动化测试 | 内置 10 场景 Self-Test（含 Host 重启任务恢复），报告落盘 |
| 调试控制台 | Set Online/Offline、Paper Out、Paper Jam、Fail Current Job、Resume、Cancel、速度、加墨 |

## 快速开始（开发环境）

要求：[Bun](https://bun.sh) ≥ 1.1（Node ≥ 20 亦可运行 host 服务）

```bash
# 1. Web 控制台（Next.js 16，端口 3000）
bun install
bun run dev

# 2. Host 守护进程（REST :3001 / Realtime :3002）
cd mini-services/ops-host
bun install
bun run dev          # bun --watch，文件变更自动重启

# 3. 打开控制台
open http://localhost:3000
```

> **沙箱/网关环境**：本仓库在受限网关（Caddy）后运行时，跨端口 API 通过
> `?XTransformPort={port}` 查询参数路由：REST → `3001`、WebSocket → `3002`。
> 见 `deploy/Caddyfile.example`。本机直连场景无需网关。

数据目录（运行时工件，全部落盘可审计）：

```
mini-services/ops-host/data/mock-printer/
├── printers.json          # 打印机注册表（状态/墨量/统计）
├── settings.json          # Host 设置（hostId/名称/安全模式）
├── devices.json           # 已配对设备
├── pairing.json           # 配对请求
├── events.jsonl           # 全局状态变化记录
├── jobs/{jobId}/
│   ├── document.pdf       # 原始 PDF
│   ├── job.json           # PrintJob + PrintOptions + 状态时间线
│   └── result.json        # 模拟打印结果
└── test-runs/{runId}.json # 自动化测试报告
```

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│ Clients：Web 控制台(MVP) │ Android(Kotlin) │ iOS(Swift)      │
│   自动发现 → 选打印机 → 提交 PDF → 实时跟踪任务               │
└──────────────┬──────────────────────────────────────────────┘
               │ OPS/1.0（REST + WebSocket；生产 + mDNS 发现）
┌──────────────▼──────────────────────────────────────────────┐
│ ops-host 守护进程（Bun/Node，REST :3001 / Realtime :3002）   │
│ ┌──────────── Core（禁止 import 平台 API）─────────────────┐│
│ │ PrinterRegistry │ JobManager(FIFO/状态机) │ EventLog     ││
│ │ VirtualPrintEngine(tick 模拟) │ Pairing │ Discovery(UDP) ││
│ └─────────┬───────────────────────────────────────────────┘│
│ ┌─────────▼ Printer Backend（可插拔，同一接口）────────────┐ │
│ │ MockPrinterBackend ★MVP │ Windows(Win32 Spooler) │ CUPS │ │
│ └─────────┬───────────────────────────────────────────────┘│
│ ┌─────────▼ Platform Adapter（按平台注入）────────────────┐ │
│ │ Windows │ macOS │ Linux │ Android │ iOS │ Web-Host(当前)│ │
│ └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 协议规范 [docs/PROTOCOL.md](docs/PROTOCOL.md) ·
虚拟打印机设计 [docs/MOCK_PRINTER.md](docs/MOCK_PRINTER.md) · 原生客户端接入 [docs/NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md)

## 目录结构

```
├── src/app/page.tsx               # 唯一入口：OPS 控制台（单页应用）
├── src/components/ops/            # 8 视图 + store + widgets
├── src/lib/ops/                   # 协议客户端 + DTO + 设备身份
├── mini-services/ops-host/        # Host 守护进程（独立 Bun 项目）
│   ├── src/core/                  # types/storage/printers/jobs/engine/pairing/discovery
│   ├── src/backends/              # mock ★ / windows / cups / android / airprint
│   ├── src/platform/              # PlatformAdapter + 当前环境适配
│   ├── src/http/  src/ws/         # REST 路由 + socket.io 实时层
│   └── src/tests/scenarios.ts     # 10 场景自动化测试
├── docs/                          # 架构/协议/虚拟打印机/原生客户端文档
├── deploy/                        # Caddy 网关示例
├── Dockerfile  docker-compose.yml # 容器部署（ghcr.io/wanan-love/ops）
└── .github/workflows/             # CI（lint）+ Docker 镜像发布到 GHCR
```

## Mock Printer / Virtual Printer

Virtual Printer 完整模拟打印生命周期（无需物理设备）：

```
正常：    PDF → 0% → 25% → 50% → 75% → 100% → Completed（工件落盘）
离线：    Queued → Printer Offline → 等待恢复 → Online → 自动续打
缺纸：    Printing → Paper Out → 暂停 → 补纸 → Resume → Completed
卡纸：    Printing → Paper Jam → 暂停 → Clear Jam → Resume → Completed
失败：    Printing → Printer Error → Failed
取消：    Queued/Printing → Cancel → Cancelled
重启：    Printing → Host 重启 → 从磁盘恢复进度 → 续打 → Completed
```

内置自动化测试（Web 控制台「调试控制台」一键运行，或 `POST /api/tests/run`）覆盖：
正常打印 / 离线 / 恢复 / 缺纸 / 卡纸 / 打印失败 / 取消任务 / 多任务排队 / 并发任务 / **Host 重启后的任务状态**。

## 平台支持矩阵

| 平台 | Host | Client | 路线 |
|---|---|---|---|
| Windows | WindowsPrinterBackend（阶段 10：Win32 Print Spooler） | 浏览器/系统打印对话框 | 阶段 10 |
| macOS | CupsPrinterBackend（阶段 10：IPP） | 浏览器/AirPrint | 阶段 10 |
| Linux | CupsPrinterBackend（阶段 10：CUPS IPP） | 浏览器/CUPS | 阶段 10 |
| Android | Android Print Framework 桥接（阶段 8+） | 原生 App（NsdManager 发现 + OPS/1.0） | [NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md) |
| iOS/iPadOS | AirPrint/IPP 透传（阶段 9+） | 原生 App（NetServiceBrowser + AirPrint） | [NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md) |
| Web（本 MVP） | ✔ Web-Host 适配器（Bun 运行时） | ✔ 控制台即客户端 | 当前 |

## Docker

```bash
# 镜像发布在 ghcr.io（Release 触发 GitHub Actions 自动构建）
docker pull ghcr.io/wanan-love/ops:latest
docker compose up -d        # web :3000 + host :3001/:3002 + caddy 网关 :80
```

## 开发阶段（Roadmap）

- [x] 1. 项目架构与仓库脚手架
- [x] 2. Core（类型/存储/队列/状态机/事件总线）
- [x] 3. Mock Printer / Virtual Printer（含 10 场景自动化测试）
- [x] 4. Discovery（UDP Beacon + HTTP 发现 + 手动添加）
- [x] 5. Protocol（OPS/1.0 REST + WebSocket 规范实现）
- [x] 6. Host 守护进程（mini-service）
- [x] 7. Web 客户端（Client + Host 控制台 + Developer 调试台）
- [ ] 8. Android 客户端（协议就绪，接入指南见 docs）
- [ ] 9. iOS 客户端（协议就绪，接入指南见 docs）
- [ ] 10. 真实打印 Backend（WindowsPrinterBackend / CupsPrinterBackend，接口已定义）

## License

Apache-2.0。第三方依赖许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
项目不复制第三方代码，仅集成其发布产物并遵循各自许可证（MIT 等）。
