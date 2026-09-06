# VENDOR_RESEARCH.md — 主流厂商官方驱动/协议真实能力研究（先研究、后开发）

> 本文档遵循「真实性红线」：只记录有官方文档或可靠公开证据支撑的结论；
> 无可靠依据的能力一律标记 **UNKNOWN / 不可靠**，绝不猜测。
> 研究方法：厂商官方文档 + RFC/IETF 标准 + 官方 MIB 文件 + 社区实证（serverfault/PRTG/HP 社区等）交叉验证。
> 本文档是 VENDOR_PROTOCOLS.md 的研究底座：VENDOR_PROTOCOLS.md 记录「我们实现了什么」，本文档记录「证据表明什么能做/不能做」。

---

## 0. 结论速览（回答用户六问）

| 问题 | 答案 |
|---|---|
| **当前真实打印机能读取什么？** | 名称/型号/驱动/状态（在线·打印中·缺纸·卡纸·离线·门开）经 Windows WMI 或 CUPS/IPP；耗材百分比经 SNMP RFC 3805 `prtMarkerSuppliesLevel`（网络激光机普遍支持）；IPP driverless 机型可读 media/sides/copies/printer-state-reasons 等真实属性。墨量对「USB 消费级喷墨」经标准协议**读不到**（见 §3） |
| **Windows 已实现什么？** | Win32_Printer 单查询枚举（名称/默认/驱动/端口/共享/网络）+ `DetectedErrorState` 官方错误码映射（无纸/卡纸/离线/门开）+ Capabilities 位掩码三态解析（彩色/双面/多份——位掩码不报告具体值时返回 UNKNOWN）+ `Start-Process -Verb PrintTo` 提交。**未实现**：DeviceCapabilities API 驱动级纸型/双面明细（见 §5 建议） |
| **CUPS/IPP 能实现什么？** | CUPS：lpstat 枚举 + IPP localhost:631 Get-Printer-Attributes 全套（media-supported/sides-supported/copies-supported/printer-state-reasons/marker-levels?）；IPP 直连：RFC 8010/8011 自研栈已支持 + ipps TLS。IPP `marker-levels` 属**可选属性**——很多机型不返回，必须 UNKNOWN 容忍 |
| **厂商驱动额外实现了什么？** | 官方驱动比标准协议多的是：墨量精确图形界面（私有双向通道）、维修件计数、纸盒明细、色彩管理。通道 = 厂商私有 SNMP MIB（HP/Lexmark 公开可下载；Ricoh NDA；Kyocera/KM 不公开）、PJL INFO 扩展（HP 发明、Brother 变体）、私有 HTTP/EWS |
| **哪些功能目前可靠可做？** | ① SNMP RFC 3805（已实现）② PJL INFO STATUS（已实现；SUPPLY 需真机抓包）③ IPP 属性（已实现）④ Windows WMI（已实现）⑤ HP-LASERJET-COMMON-MIB / LEXMARK-MIB 厂商适配（公开 MIB，证据充分，可作下两个 Vendor Adapter）⑥ Windows DeviceCapabilities API（微软官方 API，驱动级真实能力） |
| **哪些功能暂时不能做及原因？** | Epson 消费级墨量（Status Monitor 3 走私有 ESC/I 双向协议，无公开规范）；Ricoh 私有 MIB（官网 NDA 下载）；Kyocera KMnetViewer / Konica Minolta PageScope 私有 MIB（未公开）；WMI 本地打印机墨量（无标准字段）；打印速度 ppm（所有标准通道均无真实字段） |

---

## 1. 标准通道（跨厂商可靠，全部已有官方规范）

### 1.1 Printer-MIB（RFC 3805 / RFC 1759）— SNMP v1/v2c
- **官方定义**：IETF RFC 3805（Printer MIB v2），前身 RFC 1759。`prtMarkerSuppliesTable`（OID 树 `1.3.6.1.2.1.43.11`）。
- **可靠可读**：`prtMarkerSuppliesDescription`（1.3.6.1.2.1.43.11.1.1.6，耗材名）、`prtMarkerSuppliesMaxCapacity`（.8）、`prtMarkerSuppliesLevel`（.9，-3=unknown / -2=剩余不足半 / 正值=百分比或绝对量——负值语义必须按 RFC 处理，不得当 0%）。
- **状态**：`hrPrinterDetectedErrorState`（HOST-RESOURCES-MIB，RFC 2790）位掩码：低纸/无纸/卡纸/门开/墨尽等——HP 社区与 PRTG 文档均实证 LaserJet 支持。
- **厂商支持实证**：Lexmark 官方文档明确「Lexmark 网络激光打印机支持 Printer-MIB v1（RFC 1759）与 3805 V2 标准」（support.lexmark.com SNMP MIB 指南）；HP LaserJet 系列支持但**入门级/老机型 General 表可能残缺**（HP 社区实证：P2035n 未完整实现；Color LaserJet Pro MFP 4301 四台均不显示 SNMP 墨量——2024 年 HP 社区帖）；Xerox（Home Assistant 社区实证四色碳粉+页计数 OK）；Canon imageRUNNER 官方手册含 SNMP 监控章节。
- **结论**：网络激光机「大概率可读」，但**必须容忍残缺**——读不到 = UNKNOWN（我们已实现的三态模型正确）。

### 1.2 PJL（Printer Job Language）— RAW 9100
- **官方定义**：HP 开发并公开（developers.hp.com「HP Printer Command Languages: PJL」官方文档）；跨厂商事实标准。
- **可靠可读**：`@PJL INFO STATUS`（CODE 状态码：10001 就绪/10002 缺纸/10019 卡纸等——各厂商码表有差异，未知码必须返回 unknown）；`@PJL INFO CONFIG/PAGECOUNT`（内存/页计数）。
- **不可靠**：`@PJL INFO SUPPLY`（耗材）——**非 HP 标准命令**，Brother 风格变体（Kapua 博客实证「需要全网搜索隐藏的 OEM 命令」）；RUB-NDS PRET 工具的 pjl.py 展示了各厂商差异。
- **结论**：STATUS 可靠；SUPPLY 需按真机抓包逐厂商适配（我们的宽容解析 + 如实声明策略正确）。

### 1.3 IPP（RFC 8010/8011 + PWG）
- **官方定义**：RFC 8010/8011 协议；IANA IPP Registrations（属性注册表）；PWG IPP Guide。
- **可靠可读**：`printer-state`/`printer-state-reasons`（状态）、`media-supported`/`sides-supported`/`copies-supported`/`print-color-mode-supported`（提交选项，xxx-supported 形式）、`printer-make-and-model`、`pages-per-minute`（**可选**，多数驱动填充的是标称值）。
- **不可靠**：`marker-levels`（Job/Printer 可选属性——IANA 注册存在但大量实现不返回；读不到 = UNKNOWN）。
- **结论**：driverless（AirPrint/Mopria 认证）机型属性完整；老机型 IPP 实现残缺不一。

### 1.4 Windows Win32 打印栈
- **官方定义**：Microsoft Learn——Win32_Printer（WMI/CIM）、DeviceCapabilities API（wingdi.h）、DEVMODE 结构。
- **可靠可读（已实现）**：Win32_Printer 的 Name/DriverName/PortName/**Default**/Shared/Local/Network/Comment/Location；`PrinterStatus`（3 Idle/4 Printing/5 Warmup/6 Stopped/7 Offline）；**`DetectedErrorState`**（0 未知/2 无错/3 低纸/4 无纸/5 低墨/6 无墨/7 门开/8 卡纸/9 离线/10 服务请求/11 出纸器满）；Capabilities 位掩码（4 黑白/8 彩色/16 双面/32 多份/64 排序/128 装订）。
- **可靠可读（未实现——见 §5）**：DeviceCapabilities API `DC_PAPERS/DC_PAPERSIZE`（驱动级完整纸型列表——**比 WMI DefaultPaperType 单值强得多**）、`DC_DUPLEX`（双面位掩码：1=单面/2=长边/3=短边——**可区分翻转模式，WMI 做不到**）、`DC_COPIES`（真实份数上限——**WMI 位 32 只说支持多份**）、`DC_BINS`（纸盒列表）、`DC_COLORDEVICE`。
- **不可读**：墨量/耗材（WMI 无标准字段——微软官方无此接口，社区帖确认需走 SNMP 或厂商 SDK）。
- **结论**：DeviceCapabilities 是 Windows 上「驱动真实能力」的权威来源，实现它符合真实性红线（比 WMI 位掩码更精确且同样官方）。

### 1.5 CUPS（macOS/Linux）
- lpstat -p -l -d 枚举（含系统默认队列）；lp 提交带 sides/media/print-color-mode；IPP localhost:631 Get-Printer-Attributes 全套属性（同 §1.3）。CUPS 自己用 IPP 属性渲染选项——与我们现有实现一致。

---

## 2. 厂商私有通道逐一评估（九厂商）

| 厂商 | 私有能力通道 | 公开程度 | 证据 | OPS 可靠性判定 |
|---|---|---|---|---|
| **HP** | JetDirect 私有 SNMP 分支（HP-LASERJET-COMMON-MIB 等，企业 OID 11）；PJL（发明者，官方文档最全）；UPD 驱动 | **高**（MIB 文件可从 mibs.observium.org / HP 官网获取；PJL 官方文档 developers.hp.com） | HP 社区帖（SNMP 墨量实证 + 残缺机型实证）；HP-LASERJET-COMMON-MIB 在线浏览 | ✅ **可靠可做**：P4 PJL 已实现；HP 私有 MIB 适配器是下一个最佳候选（页计数/维修件增强） |
| **Canon** | imageRUNNER SNMP MIB（Canon 门户）；桌面机型走驱动双向 | **中低**（imageRUNNER MIB 需门户获取，社区 thwack 求而难得；imageCLASS 消费级无公开） | Canon 官方手册「Monitoring and Controlling via SNMP」章节 | ⚠️ **部分可做**：标准 RFC 3805 通道覆盖网络机型；私有 MIB 暂不做（获取渠道不稳定） |
| **Epson** | Status Monitor 3（ESC/I 私有双向协议，USB）；EpsonNet（网络） | **低**（ESC/I 无公开规范；Status Monitor 是驱动组件） | Epson 官方支持文档（Status Monitor 仅驱动内可用） | ❌ **暂不可做**：消费级喷墨墨量走私有协议；企业级 Scan/mopria 机型走 IPP/SNMP 标准通道即可 |
| **Brother** | PJL INFO SUPPLY 变体（「隐藏 OEM 命令」）；私有 OID | **中**（社区逆向散落：Kapua 博客/PRET 工具/serverfault 求 OID 帖） | Kapua 博客（toner levels 需 trawl 互联网找 OEM 命令）；serverfault Brother 9460 帖 | ⚠️ **试点已做、需真机抓包**：P4 的 SUPPLY 解析即 Brother 风格试点；无真机验证前**不得**宣称支持 |
| **Xerox** | CentreWare EWS；MIB 文件 | **中**（Home Assistant 社区实证标准 SNMP 四色碳粉+页计数可读；私有 MIB 分散） | HA 社区帖（SNMP 全部四色 OK）；PRTG KB（用户自寻 MIB） | ✅ **标准通道可靠**；私有增强暂不做 |
| **Ricoh** | 私有 MIB（官网 RiDP 门户 **NDA 下载**） | **低**（需签 NDA） | Reddit sysadmin 帖（明示 NDA 流程） | ❌ **不可做**（合规边界：NDA 代码不能进开源项目）；标准 RFC 3805 通道照常覆盖 |
| **Kyocera** | KMnetViewer 管理工具的私有 MIB | **低**（未公开） | 无公开 MIB 下载渠道 | ❌ 暂不做；标准通道覆盖 |
| **Konica Minolta** | PageScope 私有接口 | **低**（未公开） | 同上 | ❌ 暂不做；标准通道覆盖 |
| **Lexmark** | LEXMARK-MPS-MIB 等公开 MIB 族 | **高**（官方文档 + MIB 公开可下载；官方文档明确 RFC 1759/3805 支持） | support.lexmark.com「SNMP MIB and OID Values Explained」；LEXMARK-MPS-MIB 在线浏览 | ✅ **可靠可做**：与 HP 并列的下一个 Vendor Adapter 候选 |

---

## 3. 墨量/耗材可读性总表（真实性核心）

| 通道 | 激光机（网络） | 喷墨（消费级 USB） | 喷墨（网络/一体机） |
|---|---|---|---|
| SNMP RFC 3805 | ✅ 大概率（HP/Lexmark/Xerox/Ricoh/Kyocera/KM 实证；入门级残缺风险） | ❌ 多数不支持 | ⚠️ 机型相关 |
| IPP marker-levels | ⚠️ driverless 机型 | ⚠️ AirPrint 机型 | ⚠️ 机型相关（可选属性） |
| PJL INFO SUPPLY | ⚠️ Brother/HP 变体（需抓包） | ❌ | ⚠️ Brother 变体 |
| Windows WMI | ❌ 无字段 | ❌ 无字段 | ❌ 无字段 |
| 厂商私有 MIB/API | ✅ HP/Lexmark（公开）；Ricoh NDA ✗ | ❌（ESC/I 私有） | 机型相关 |

**结论**：耗材必须维持「多通道探测 + 三态 + 机型残缺容忍」——这正是现行架构；任何「统一显示墨量」的做法必然违反真实性。

---

## 4. 与现行实现对齐性检查

| 现行实现 | 与研究结论的一致性 |
|---|---|
| SNMP probeSnmpConsumables/probeStatus（P0/P1） | ✅ 完全对齐 RFC 3805（含负值语义） |
| PJL probePjlStatus/probePjlSupply（P4） | ✅ STATUS 对齐官方；SUPPLY 如实声明「Brother 试点格式，真机需抓包」——未越线 |
| IPP Get-Printer-Attributes（自研栈） | ✅ 对齐 IANA/PWG 属性模型；marker-levels 未强制 |
| Windows Win32_Printer 枚举 + DetectedErrorState | ✅ 对齐微软官方字段语义（本轮已重写） |
| Windows maxCopies=99 / duplex='both' 猜测值 | ✅ **本轮已修正为 UNKNOWN**（WMI 位掩码不提供具体值——研究确认 DeviceCapabilities 才有 DC_COPIES/DC_DUPLEX） |
| Mock/Virtual 全部隔离到 OPS_DEV_MODE | ✅ 本轮完成（正式产物无虚拟设备） |

---

## 5. 下一步功能建议（按证据强度排序，先研究后开发原则）

1. **Windows DeviceCapabilities API 适配**（微软官方 wingdi.h；DC_PAPERS/DC_DUPLEX/DC_COPIES/DC_BINS/DC_COLORDEVICE）——驱动级真实能力，比 WMI 位掩码精确一个数量级；实现路径：PowerShell `Add-Type` P/Invoke 或 C# 内联。**证据充分，建议 P5 首选**。
2. **HP 私有 MIB 适配器**（HP-LASERJET-COMMON-MIB 公开）——维修件计数/页计数/纸盒增强，第二个 Vendor Adapter。
3. **Lexmark MIB 适配器**（官方文档 + LEXMARK-MPS-MIB 公开）——同上并列。
4. **Brother PJL SUPPLY 真机抓包适配**——需要真机（当前无，保持试点声明）。
5. **不做**：Epson 消费级墨量、Ricoh NDA MIB、Kyocera/KM 私有接口、任何 EWS 网页抓取（脆弱且非契约）。

---

## 6. 参考来源（本轮检索 2026-09）

- RFC 3805 / RFC 1759（Printer MIB）/ RFC 2790（HOST-RESOURCES）/ RFC 8010/8011（IPP）/ RFC 3380
- IANA「Internet Printing Protocol (IPP) Registrations」；PWG IPP Guide（istopwg.github.io）
- Microsoft Learn：Win32_Printer、DeviceCapabilitiesA（wingdi.h）、DEVMODEA、DocumentProperties
- developers.hp.com「HP Printer Command Languages: PJL」
- Lexmark support「SNMP MIB and OID Values Explained」；mibs.observium.org（HP-LASERJET-COMMON-MIB / LEXMARK-MPS-MIB / Printer-MIB 浏览）
- HP 社区（h30434.www3.hp.com：SNMP 墨量实证与 4301 缺失实证）；Canon 官方手册（SNMP 监控章节）；Epson 官方（Status Monitor 3 文档）
- 社区实证：serverfault（页计数/Brother OID）、Reddit sysadmin（Ricoh NDA 流程）、Home Assistant（Xerox 四色实证）、Kapua 博客（Brother PJL SUPPLY）、RUB-NDS PRET（PJL 工具实现）
