# OpenPrintShare (OPS)

> 跨平台局域网共享打印机 — 设备 A 安装 Host 共享系统打印机，Windows / macOS / Linux / Android / iOS 设备自动发现并打印。

[![Release](https://img.shields.io/badge/release-v0.3.0--cross--platform-emerald)](../../releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](#license)
[![Backend](https://img.shields.io/badge/print%20backends-IPP%20%7C%20CUPS%20%7C%20Windows-teal)](#打印后端)
[![Self-Test](https://img.shields.io/badge/self--test-15%2F15%20scenarios%20passing-brightgreen)](#开发与测试环境mock--virtual)

> 📖 **新用户从零开始**：安装、配置、共享打印机、客户端打印、故障排查——见完整使用指南 **[docs/USAGE.md](docs/USAGE.md)**。

## 项目目标

```
Client(发现 Host) → 浏览共享打印机 → 提交 PDF
      → Host(ops-host 守护进程) → 系统原生打印(A 已安装驱动) → 打印机
```

- **优先兼容操作系统原生打印能力**：CUPS / IPP / IPP Everywhere / Bonjour(mDNS/DNS-SD) / Windows Print Spooler / Android Print Framework / AirPrint
- **ipps:// TLS**：加密 IPP 传输，自签名证书自动容忍（TOFU）
- **客户端尽量无需安装厂商驱动**，实际打印使用 Host（设备 A）上已安装的系统打印机与驱动
- 切换真实打印机时，仅替换 Printer Backend，**Core / 协议 / 队列 / UI 零改动**

## 打印后端（第二阶段 v0.2.0）

统一 `PrinterBackend` 接口（listPrinters / getPrinter / getCapabilities / getStatus / submitJob / getJobStatus / cancelJob）：

| 后端 | 状态 | 说明 |
|---|---|---|
| **IPPPrinterBackend** | ✔ 通过 Virtual IPP Server 全链路验证（含 ipps TLS） | 自研 RFC 8010/8011 二进制协议栈，直连 ipp:// / ipps://（TLS 自签容忍）网络打印机 |
| **CupsPrinterBackend** | 代码完备，待 CUPS 宿主验证 | lpstat/lp CLI + ipp://localhost:631，macOS/Linux |
| **WindowsPrinterBackend** | 代码完备，待 Windows 宿主验证 | PowerShell Get-Printer/Get-PrintJob/Win32_Printer + PrintTo |
| SNMP 耗材/状态探测 | 代码完备，待真实设备验证 | 自研 RFC 1157 BER 编解码：Printer-MIB prtMarkerSuppliesLevel（耗材）+ HOST-RESOURCES hrPrinterDetectedErrorState（缺纸/卡纸/门开位掩码，状态二级来源）；community 可配置（设置页） |
| mDNS/Bonjour 发现 | ✔ 本机回环验证 | 自研 RFC 6762/6763 UDP 组播（_ipp._tcp 浏览 + 自通告） |

> 开发/测试用的 MockPrinterBackend 见[开发与测试环境](#开发与测试环境mock--virtual)（仅限单元测试 / 集成测试 / CI / 开发环境，非产品功能）。

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

### Virtual IPP Server（开发/测试工具）

面向开发与 CI 环境的本地 IPP 模拟服务，用于无实体打印机时验证真实 IPP 二进制协议链路（非产品功能，生产可用 `OPS_VIPP_ENABLED=0` 关闭）。内置 4 台不同能力档案：

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
| 打印任务/队列 | FIFO 队列、实时进度（25/50/75/100 里程碑）、状态时间线、取消/重试 |
| PDF 打印 | 拖放上传、A4/Letter 等纸型、彩色/黑白、单双面、份数、质量、页面范围 |
| 基础设备配对 | 开放模式（默认）/ 配对模式（设备令牌 X-OPS-Token） |
| 跨平台打包 | scripts/build-* 统一构建 → dist/{windows,macos,linux,android,ios}，运行时随包提供（见[跨平台打包](#跨平台打包)） |

## 快速开始（正式产物，开箱即用）

各平台构建产物在 [GitHub Releases](../../releases) 下载：**用户下载 → 双击 → 启动 → 浏览器打开控制台**。
运行时（Bun + 全部依赖）已随程序打包，**无需安装 Node.js / Python / Rust / Java**。

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `OpenPrintShare-Windows-x64-<ver>.exe` | 单文件可执行（Web 控制台内嵌）；`.msi` 安装器与 `.zip` 便携版 |
| macOS | `OpenPrintShare-macOS-arm64-<ver>.dmg` | `.app`（arm64 + x64）；首次启动如遇 Gatekeeper，右键 → 打开 |
| Linux | `OpenPrintShare-Linux-x64-<ver>.AppImage` | 可执行 AppImage；`.deb`（apt 系）+ 裸二进制（x64 + arm64） |
| Android | `OpenPrintShare-Android-arm64-<ver>.apk` | 客户端（连接局域网 Host 的控制台） |
| iOS/iPadOS | Xcode 工程（`clients/ios`） | Build/Archive/TestFlight（见 `clients/ios` 内指引） |

统一构建（本地可交叉编译 Windows/macOS/Linux 单文件）：

```bash
bash scripts/build-all.sh           # → dist/{windows,macos,linux,android,ios}/
bash scripts/build-linux.sh x64     # 单平台：单文件 + .deb + AppImage
bash scripts/build-windows.sh       # 单平台：exe + 便携 zip
```

- 打包原理：`bun build --compile`（运行时内嵌）+ Next.js 静态导出（`OPS_EXPORT=1`）资产嵌入二进制 → **单文件可执行**
- Web 控制台由 Host 直接服务（`http://localhost:3001/`），REST 同源直连、WebSocket 独立端口（默认 3002）
- CI 自动构建：推送 `v*` tag 触发 `.github/workflows/release-build.yml`（Linux/Windows/macOS/Android/iOS 并行构建 + 自动发布 Release）
- 依赖说明：CUPS 为系统组件（macOS/Linux 自带；Windows 使用系统打印栈），无需用户安装；如宿主缺少对应组件，后端探测会给出明确说明（打印后端页可见）

命令行参数（所有平台一致）：

```bash
openprintshare [--port 3001] [--ws-port 3002] [--data-dir <dir>] [--web <dir>] [--no-vipp] [--version]
```

## 快速开始（开发环境）

要求：[Bun](https://bun.sh) ≥ 1.1（Node ≥ 20 亦可运行 host 服务）

```bash
# 1. Web 控制台（Next.js 16，端口 3000）
bun install
bun run dev

# 2. Host 守护进程（REST :3001 / Realtime :3002 / Virtual IPP :3061 + TLS :3063）
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
│ ┌─────────▼ Virtual IPP Server :3061 + TLS :3063（验证真实 IPP）─┐ │
│ │ 4 档能力档案（full/basic/mono/minimal）+ mDNS 自通告    │ │
│ └──────────────────────────────────────────────────────────┘│
│ ┌─────────▼ Platform Adapter（按平台注入）────────────────┐ │
│ │ Windows │ macOS │ Linux │ Android │ iOS │ Web-Host(当前)│ │
│ └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 使用指南 [docs/USAGE.md](docs/USAGE.md) · 协议规范 [docs/PROTOCOL.md](docs/PROTOCOL.md) ·
虚拟打印机设计 [docs/MOCK_PRINTER.md](docs/MOCK_PRINTER.md) · 原生客户端接入 [docs/NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md) ·
厂商协议研究 [docs/VENDOR_PROTOCOLS.md](docs/VENDOR_PROTOCOLS.md)

## 目录结构

```
├── src/app/page.tsx               # 唯一入口：OPS 控制台（单页应用）
├── src/components/ops/            # 9 视图 + store + widgets
├── src/lib/ops/                   # 协议客户端 + DTO + 设备身份
├── mini-services/ops-host/        # Host 守护进程（独立 Bun 项目，打包入口 index.ts）
│   ├── index.ts                   # CLI（--port/--web/--data-dir/--version）
│   ├── src/core/                  # types/storage/printers/jobs/engine/pairing/discovery
│   ├── src/backends/              # ipp(自研 RFC 8010/8011) / cups / windows / mock / snmp
│   ├── src/vipp/                  # Virtual IPP Server（开发/测试工具）
│   ├── src/http/  src/ws/         # REST 路由（含静态 Web 服务）+ socket.io 实时层
│   └── src/tests/                 # 15 场景自动化测试
├── clients/                       # 原生客户端
│   ├── android/                   # WebView 壳（Kotlin/Gradle，连接局域网 Host）
│   └── ios/                       # SwiftUI WKWebView 壳（Xcode 工程可直接 Build/Archive）
├── scripts/
│   ├── build-all.sh               # 全平台统一构建入口
│   ├── build-web.sh               # Next 静态导出 + 嵌入清单
│   ├── build-host.sh              # bun build --compile（linux/windows/darwin × x64/arm64）
│   ├── build-linux.sh             # 单文件 + .deb + AppImage
│   ├── build-windows.sh           # exe + 便携 zip（CI 补 .msi）
│   ├── build-macos.sh             # 单文件（macOS 宿主/CI 补 .app/.dmg）
│   ├── build-android.sh           # APK（需 SDK；CI 自动）
│   ├── build-ios.sh               # Xcode 工程校验/构建（需 macOS）
│   └── build-web-embed.ts         # Web 资产嵌入清单生成器
├── packaging/windows/             # WiX v4 MSI 安装器定义
├── docs/                          # 架构/协议/使用指南/虚拟打印机/原生客户端/厂商协议研究文档
├── deploy/                        # Caddy 网关示例
├── dist/                          # 构建产物输出（gitignore，Releases 发布）
├── Dockerfile  docker-compose.yml # 容器部署（ghcr.io/wanan-love/ops）
└── .github/workflows/             # CI（lint）+ Docker（ghcr）+ release-build（多平台产物）
```

## 开发与测试环境（Mock / Virtual）

> **Mock 组件仅用于开发与测试**（单元测试 / 集成测试 / CI / 自动化测试 / 无打印机的开发环境），
> 不是产品功能，也不在最终用户文档中作为使用方式宣传。

- `MockPrinterBackend / Virtual Printer`：模拟完整打印生命周期，支持 10 种状态注入（Offline / Paper Out / Paper Jam / Error / Busy / Printing / Failed / Cancelled / Completed / 恢复续打），供自动化测试与协议验证使用：

```
正常：    PDF → 0% → 25% → 50% → 75% → 100% → Completed（工件落盘）
离线：    Queued → Printer Offline → 等待恢复 → Online → 自动续打
缺纸：    Printing → Paper Out → 暂停 → 补纸 → Resume → Completed
卡纸：    Printing → Paper Jam → 暂停 → Clear Jam → Resume → Completed
失败：    Printing → Printer Error → Failed
取消：    Queued/Printing → Cancel → Cancelled
重启：    Printing → Host 重启 → 从磁盘恢复进度 → 续打 → Completed
```

- `Virtual IPP Server`：本地 IPP 模拟服务（真实 RFC 8010/8011 二进制协议，明文 :3061 + TLS :3063 自签证书），供 CI/开发环境验证 IPPPrinterBackend 全链路（含 ipps）；四档能力档案用于测试能力三态模型（详见上表）。
- 自动化测试（15 场景：10 Mock + 5 IPP/mDNS（含 ipps TLS），含 Host 重启任务恢复）：`POST /api/tests/run` 或 Web 控制台「调试 · 开发测试」页一键运行，报告落盘 `test-runs/`。

## 平台支持矩阵

| 平台 | Host | Client | 路线 |
|---|---|---|---|
| Windows | WindowsPrinterBackend（PowerShell 打印栈）+ 单文件 exe/msi | 浏览器/系统打印对话框 | 后端待 Windows 宿主验证 |
| macOS | CupsPrinterBackend（IPP/CUPS）+ .app/.dmg | 浏览器/AirPrint | 后端待 macOS 宿主验证 |
| Linux | CupsPrinterBackend（CUPS/IPP）+ AppImage/.deb | 浏览器/CUPS | 后端待 CUPS 宿主验证 |
| Android | —（手机作为客户端） | ✔ WebView 壳（`clients/android`，连接局域网 Host） | 原生接入指南见 [NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md) |
| iOS/iPadOS | —（手机/平板作为客户端） | ✔ SwiftUI 壳（`clients/ios`，Xcode 可直接 Build/Archive） | 原生接入指南见 [NATIVE_CLIENTS.md](docs/NATIVE_CLIENTS.md) |
| Web | ✔ Web-Host 适配器（Bun 运行时） | ✔ 控制台即客户端 | 当前 |

## Docker

```bash
# 镜像发布在 ghcr.io（Release 触发 GitHub Actions 自动构建）
docker pull ghcr.io/wanan-love/ops:latest
docker compose up -d        # web :3000 + host :3001/:3002 + caddy 网关 :80
```

## 开发阶段（Roadmap）

- [x] 1. 项目架构与仓库脚手架
- [x] 2. Core（类型/存储/队列/状态机/事件总线）
- [x] 3. Mock Printer / Virtual Printer（含 10 场景自动化测试；定位为开发/测试工具）
- [x] 4. Discovery（UDP Beacon + HTTP 发现 + 手动添加）
- [x] 5. Protocol（OPS/1.0 REST + WebSocket 规范实现）
- [x] 6. Host 守护进程（mini-service）
- [x] 7. Web 客户端（Client + Host 控制台 + Developer 调试台）
- [x] 8. Android 客户端（WebView 壳工程 `clients/android`，APK 由 CI 构建）
- [x] 9. iOS 客户端（SwiftUI 工程骨架 `clients/ios`，Xcode 可直接 Build/Archive）
- [x] 10. 真实打印 Backend（IPP ✔ Virtual IPP 全链路验证 / ipps TLS ✔ 自签容忍 TOFU / CUPS / Windows 代码完备待宿主验证 / 能力三态 / mDNS / SNMP）
- [x] 11. 跨平台打包（单文件可执行 + .deb/.AppImage/.msi/.dmg/.apk + CI 自动构建发布）
- [ ] 12. 真实硬件验证（CUPS 宿主 / Windows 宿主 / SNMP 实际墨量 / 跨主机 mDNS / ipps TLS 真机证书校验）
- [ ] 13. 厂商专用能力（协议对比研究已完成：[docs/VENDOR_PROTOCOLS.md](docs/VENDOR_PROTOCOLS.md) —— 结论：标准五通道覆盖约 90% 常见需求，缺口集中在耗材长尾与扫描；Vendor Adapter 按「只提升 UNKNOWN、绝不覆盖 SUPPORTED」渐进补齐）

## License

Apache-2.0。第三方依赖许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
项目不复制第三方代码，仅集成其发布产物并遵循各自许可证（MIT 等）。
