# OpenPrintShare (OPS)

> 跨平台局域网共享打印机 — 设备 A 安装 Host 共享系统打印机，Windows / macOS / Linux / Android / iOS 设备自动发现并打印。

[![Release](https://img.shields.io/badge/release-v0.2.0--real--backends-emerald)](../../releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](#license)
[![Backend](https://img.shields.io/badge/print%20backends-Mock%20%7C%20IPP%20%7C%20CUPS%20%7C%20Windows-teal)](#打印后端)
[![Self-Test](https://img.shields.io/badge/self--test-14%2F14%20scenarios%20passing-brightgreen)](#mock-printer--virtual-printer)

## 项目目标

```
Client(发现 Host) → 浏览共享打印机 → 提交 PDF
      → Host(ops-host 守护进程) → 系统原生打印(A 已安装驱动) → 打印机
```

- **优先兼容操作系统原生打印能力**：CUPS / IPP / IPP Everywhere / Bonjour(mDNS/DNS-SD) / Windows Print Spooler / Android Print Framework / AirPrint
- **客户端尽量无需安装厂商驱动**，实际打印使用 Host（设备 A）上已安装的系统打印机与驱动
- **没有真实打印机也能完整运行**：内置 `MockPrinterBackend`（Virtual Printer）+ `Virtual IPP Server`（真实 IPP 二进制协议链路可本地验证）
- 切换真实打印机时，仅替换 Printer Backend，**Core / 协议 / 队列 / UI 零改动**

## 打印后端（第二阶段 v0.2.0）

统一 `PrinterBackend` 接口（listPrinters / getPrinter / getCapabilities / getStatus / submitJob / getJobStatus / cancelJob）：

| 后端 | 状态 | 说明 |
|---|---|---|
| **MockPrinterBackend** | ✔ 全功能验证 | Virtual Printer 模拟引擎，无需物理设备 |
| **IPPPrinterBackend** | ✔ 通过 Virtual IPP Server 全链路验证 | 自研 RFC 8010/8011 二进制协议栈，直连 ipp:// 网络打印机 |
| **CupsPrinterBackend** | 代码完备，待 CUPS 宿主验证 | lpstat/lp CLI + ipp://localhost:631，macOS/Linux |
| **WindowsPrinterBackend** | 代码完备，待 Windows 宿主验证 | PowerShell Get-Printer/Get-PrintJob/Win32_Printer + PrintTo |
| SNMP 耗材探测 | 代码完备，待真实设备验证 | 自研 RFC 1157 BER 编解码，Printer-MIB prtMarkerSuppliesLevel |
| mDNS/Bonjour 发现 | ✔ 本机回环验证 | 自研 RFC 6762/6763 UDP 组播（_ipp._tcp 浏览 + 自通告） |

### 能力三态模型（硬性规则）

**禁止按品牌/型号猜测能力**。所有能力从真实设备/系统读取，每项能力记录四元组：

```json
color: {
  "value": true,            // null = 读取不到
  "state": "SUPPORTED",     // SUPPORTED | UNSUPPORTED | UNKNOWN
  "source": "IPP",          // SYSTEM | CUPS | IPP | WSD | SNMP | VENDOR_API | UNKNOWN
  "timestamp": "2026-09-06T07:47:23Z"
}
```

- **读取不到 ≠ 不支持**：无 `sides-supported` 属性 → 双面 `UNKNOWN`（而非 UNSUPPORTED）
- **耗材不可作为必有字段**：`marker-levels` 缺失 → 耗材 `UNKNOWN`，UI 直接隐藏耗材模块（不显示假 0%）
- **协议失败不影响打印机可用**：IPP ✅ 打印 ✅ 双面 ✅ SNMP ❌ 墨量 UNKNOWN → 打印机仍正常可打印
- 支持多来源并行探测与能力动态刷新（`POST /api/printers/:id/refresh-capabilities`）

### Virtual IPP Server（本地可验证真实 IPP 协议）

内置 4 台不同能力档案的虚拟 IPP 打印机（:3061，RFC 8010/8011 真实二进制交互）：

| 档案 | 能力暴露 | 验证目标 |
|---|---|---|
| `vipp-full` | 完整能力 + marker-levels 耗材 | SUPPLIED 全链路（发现→探测→提交→完成） |
| `vipp-basic` | 无 marker-*（耗材 UNKNOWN）、无 sides-supported（双面 UNKNOWN） | 「读取不到 ≠ 不支持」且打印仍成功 |
| `vipp-mono` | color-supported=false（UNSUPPORTED） | 确认不支持的正确标记 |
| `vipp-minimal` | 仅 printer-state + printer-name | 最吝啬设备（其余全 UNKNOWN） |

## MVP 功能（v0.2.0）

| 能力 | 说明 |
|---|---|
| 局域网自动发现 | Host UDP Beacon（生产：Bonjour/Avahi `_ops._tcp`）+ HTTP 发现 + 手动 IP/端口添加 |
| mDNS 打印机发现 | 纯 TS UDP 组播浏览 `_ipp._tcp`（RFC 6762/6763）+ Virtual IPP 自通告 |
| Host / Client | `ops-host` 守护进程（REST + WebSocket）+ Web 控制台（Client + Host 控制台 + 调试台） |
| 共享/取消共享打印机 | 一键开关，客户端实时可见性同步 |
| 打印机状态 | online / busy / offline / paper-out / paper-jam / error + CMYK 墨量（模拟）/ IPP 状态同步（真实） |
| 真实能力探测 | 能力三态（SUPPORTED/UNSUPPORTED/UNKNOWN）+ 四元组（value/state/source/timestamp）+ 多来源并行探测 |
| 打印任务/队列 | FIFO 队列、实时进度（25/50/75/100 里程碑）、状态时间线、取消/重试（Mock 与真实后端同体验） |
| PDF 打印 | 拖放上传、A4/Letter 等纸型、彩色/黑白、单双面、份数、质量、页面范围 |
| 基础设备配对 | 开放模式（默认）/ 配对模式（设备令牌 X-OPS-Token） |
| Virtual Printer | 无物理设备模拟完整打印流程，支持 10 种状态注入 |
| Virtual IPP Server | 真实 IPP 二进制协议链路本地验证（4 档能力档案） |
| 自动化测试 | 内置 14 场景 Self-Test（10 Mock + 4 IPP/mDNS，含 Host 重启任务恢复），报告落盘 |
| 调试控制台 | Set Online/Offline、Paper Out、Paper Jam、Fail Current Job、Resume、Cancel、速度、加墨 |

## 快速开始（开发环境）

要求：[Bun](https://bun.sh) ≥ 1.1（Node ≥ 20 亦可运行 host 服务）

```bash
# 1. Web 控制台（Next.js 16，端口 3000）
bun install
bun run dev

# 2. Host 守护进程（REST :3001 / Realtime :3002 / Virtual IPP :3061）
cd mini-services/ops-host
bun install
bun run dev          # bun --watch，文件变更自动重启

# 3. 打开控制台
open http://localhost:3000

# 4.（可选）验证真实 IPP 链路：控制台 →「打印后端」→ 导入 vipp-* 打印机
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
│ ┌─────────▼ Printer Backend（可插拔，统一七方法接口）──────┐ │
│ │ Mock ★ │ IPP(RFC 8010/8011 自研) │ CUPS │ Windows(PS) │ │
│ │ SNMP 耗材探测 │ 能力三态合并器（多来源，失败隔离）      │ │
│ └─────────┬────────────────────────────────────────────────┘│
│ ┌─────────▼ Virtual IPP Server :3061（本地验证真实 IPP）──┐ │
│ │ 4 档能力档案（full/basic/mono/minimal）+ mDNS 自通告    │ │
│ └──────────────────────────────────────────────────────────┘│
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
