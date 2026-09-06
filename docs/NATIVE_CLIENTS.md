# 原生客户端接入指南（Android / iOS）

MVP 已提供完整 OPS/1.0 协议与 Virtual Printer 演示环境，Android/iOS 客户端按本指南接入。
**核心原则：客户端不安装厂商驱动**——PDF 直接提交给 Host，由 Host 侧已安装的系统打印机完成实际打印。

## 1. 发现 Host

| 平台 | 推荐技术 | 说明 |
|---|---|---|
| Android | `NsdManager`（`_ops._tcp.`） | MVP 期间可退化为 UDP Beacon 监听（端口 44445，JSON：`{service:"openprintshare", hostId, hostName, restPort}`）或手动 IP:端口 |
| iOS | `NetServiceBrowser`（Bonjour） | 同上；AirPrint 打印机本身通过 `_ipp._tcp` / `_universal._sub._ipp._tcp` 发现 |
| 生产 Host | Avahi（Linux）/ Bonjour（macOS/Win）注册 `_ops._tcp` + `_ipp._tcp` | 见 docs/ARCHITECTURE.md 阶段 10 |

发现后调用 `GET /api/system/info` 确认（返回 HostInfo 即为 OPS Host）。

## 2. Android 客户端（Kotlin）

```
发现(NsdManager) → 配对(可选) → GET /api/printers?scope=client → 选打印机
→ POST /api/jobs（PDF bytes + X-OPS-Options）→ 监听任务状态
```

要点：

- **打印提交**：`OkHttp`/`Retrofit` 直接 `POST` PDF 字节流（`application/pdf`），选项 JSON 放 header
- **实时状态**：可选 `socket.io-client-java`，或轮询 `GET /api/jobs/{id}`（1s 足够 MVP）
- **本地生成 PDF**：`PrintedPdfDocument` / `PdfDocument`，或 `android.print.PrintManager` + `PrintDocumentAdapter` 的 layout 回调中把文档写为 PDF 再提交
- **Android Print Framework 对接（阶段 8+）**：实现一个 `PrintService`，把 OPS 共享的打印机注册为系统打印服务目标（`PrinterInfo`），系统打印对话框即可直接选择 OPS 打印机；提交时走 `onPrint`（JobInfo 内的 PDF）转发给 Host
- **最小权限**：局域网 socket + Internet

## 3. iOS / iPadOS 客户端（Swift）

```
发现(NetServiceBrowser) → 配对(可选) → 打印机列表 → 生成 PDF → POST /api/jobs → 状态
```

要点：

- **PDF 生成**：`UIGraphicsPDFRenderer`；分享/预览用 `PDFKit`
- **提交**：`URLSession.uploadTask`（`httpBody` = PDF Data，header 带 `X-OPS-Options`）
- **AirPrint 路线（阶段 9+）**：Host 侧（macOS/Linux）通过 CUPS+Avahi 通告 IPP Everywhere 打印机后，iOS 系统打印对话框（`UIPrintInteractionController`）**无需安装任何 App** 即可发现并打印——这是 iOS 的首选路径，OPS Host 只需把共享打印机以 IPP Everywhere 形式通告（阶段 10 的 CupsPrinterBackend 自带）
- **配对**：`POST /api/pairing/requests` + 轮询 `/api/pairing/status?deviceId=` 领取令牌，存 Keychain

## 4. 共同约定

- **设备身份**：首次启动生成 UUID（Android 存 DataStore / iOS 存 Keychain），每次请求带 `X-OPS-Device` / `X-OPS-Device-Name` / `X-OPS-Platform`
- **安全模式 pairing 开启时**：所有打印请求携带 `X-OPS-Token`
- **选项**：`{paperSize:"A4", colorMode:"color"|"monochrome", duplex:"none"|"long-edge"|"short-edge", copies:1-99, quality, pageRange}`（服务端按打印机能力钳制）
- **错误处理**：4xx 的 `{error}` 文案可直接展示给用户（含"打印机未共享/缺纸/未配对"等场景）

## 5. 无真实打印机时的联调

Web 控制台（本仓库）+ Virtual Printer 即为完整联调环境：原生客户端向 Host 提交 PDF 后，
在 Web 控制台「调试控制台」注入 Paper Out/Paper Jam 等状态，即可验证客户端的状态展示与恢复交互。
