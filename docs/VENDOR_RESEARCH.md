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
| **Windows 已实现什么？** | Win32_Printer 单查询枚举（名称/默认/驱动/端口/共享/网络）+ `DetectedErrorState` 官方错误码映射（无纸/卡纸/离线/门开）+ Capabilities 位掩码三态解析 + `Start-Process -Verb PrintTo` 提交（v0.4.3：PDF 临时文件传递，修复命令行长度上限）。**DeviceCapabilities API 驱动级能力已实现（P5 ✔ v0.4.3）**：DC_PAPERNAMES 纸型列表 / DC_DUPLEX 翻转模式 / DC_COPIES 份数上限 / DC_BINNAMES 纸盒列表 / DC_COLORDEVICE 彩色（只提升 UNKNOWN、不降级 WMI 结论；墨量仍无源 UNKNOWN） |
| **CUPS/IPP 能实现什么？** | CUPS：lpstat 枚举 + IPP localhost:631 Get-Printer-Attributes 全套（media-supported/sides-supported/copies-supported/printer-state-reasons/marker-levels?）；IPP 直连：RFC 8010/8011 自研栈已支持 + ipps TLS。IPP `marker-levels` 属**可选属性**——很多机型不返回，必须 UNKNOWN 容忍 |
| **厂商驱动额外实现了什么？** | 官方驱动比标准协议多的是：墨量精确图形界面（私有双向通道）、维修件计数、纸盒明细、色彩管理。通道 = 厂商私有 SNMP MIB（HP/Lexmark 公开可下载；Ricoh NDA；Kyocera/KM 不公开）、PJL INFO 扩展（HP 发明、Brother 变体）、私有 HTTP/EWS。**P8 官方驱动逆向实证五包**：HP HPLIP 源码（LEDM XML /CDM JSON HTTP 端点 + PML→RFC 3805 + 9100/9101/9102 通道表 + Device-ID SNMP OID）、Canon cnijfilter2（ivec XML GetStatus/Cleaning + BJNP UDP 8611 + Cnmpu2_port9100 + HTTP /canon/ij/command*）、Brother pdrv（PJL 流 UEL+SET OUTBIN + 安装器默认 LPD BINARY_P1）、Epson 双代（escpr 墨量 API/代际断崖）、Lexmark inkjet-08（NPA 私有协议 + host-based）——均归档 `docs/vendor-evidence/`（详见 `MULTI_BRAND_DRIVERS_ANALYSIS.md`） |
| **哪些功能目前可靠可做？** | ① SNMP RFC 3805（已实现；HP HPLIP 官方代码正面实证同读法）② PJL INFO STATUS（已实现；Brother 官方驱动实证 PJL 语言层，SUPPLY 响应需真机）③ IPP 属性（已实现；HPLIP 亦将 IPP 列为官方 13 类状态通道之一）④ Windows WMI（已实现）⑤ HP-LASERJET-COMMON-MIB / LEXMARK-MIB 厂商适配（公开 MIB，证据充分，可作下两个 Vendor Adapter）⑥ Windows DeviceCapabilities API（微软官方 API，驱动级真实能力）⑦ **HP LEDM/CDM HTTP 适配（✅ P9 已实现 v0.4.7：LEDM :8080 XML 三文档 + CDM :80 JSON 只读探测 + 场景 22 全链路自测；真实机型响应细节以实测为准）** |
| **哪些功能暂时不能做及原因？** | Ricoh 私有 MIB（官网 NDA 下载）；Kyocera KMnetViewer / Konica Minolta PageScope 私有 MIB（未公开）；WMI 本地打印机墨量（无标准字段）；打印速度 ppm（所有标准通道均无真实字段）。**Epson 消费级墨量（代际拆分，P7 双逆向）**：新代（L4350 等）官方驱动逆向（escpr 1.7.9 libescpr）实证墨量 API 存在（`epsGetSupplyInfo`/`epsGetInkInfo`）但无公开 ABI——「可研究但需真机」；**老代低端（L130…L455，201401w 驱动）官方库零状态 API 零网络栈——Linux 侧官方自身不提供任何读取通道，IPP/SNMP 读不到即 UNKNOWN 终态** |

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
- **可靠可读（P5 已实现 · v0.4.3）**：DeviceCapabilities API `DC_PAPERS/DC_PAPERSIZE`（驱动级完整纸型列表——**比 WMI DefaultPaperType 单值强得多**）、`DC_DUPLEX`（双面模式：1=单面/2=长边/3=短边——**可区分翻转模式，WMI 做不到**；位掩码/常量双解释保守映射）、`DC_COPIES`（真实份数上限——**WMI 位 32 只说支持多份**）、`DC_BINNAMES`（纸盒列表——新增 paperTrays 能力轴）、`DC_COLORDEVICE`（驱动级彩色）。实现：PowerShell `Add-Type` 内联 C# P/Invoke，单次查询全部 5 项，仅 Windows 宿主执行，探测失败仅记 probe 不覆盖既有值，TTL 缓存 10 分钟。
- **不可读**：墨量/耗材（WMI 无标准字段——微软官方无此接口，社区帖确认需走 SNMP 或厂商 SDK）。
- **结论**：DeviceCapabilities 是 Windows 上「驱动真实能力」的权威来源，实现它符合真实性红线（比 WMI 位掩码更精确且同样官方）。

### 1.5 CUPS（macOS/Linux）
- lpstat -p -l -d 枚举（含系统默认队列）；lp 提交带 sides/media/print-color-mode；IPP localhost:631 Get-Printer-Attributes 全套属性（同 §1.3）。CUPS 自己用 IPP 属性渲染选项——与我们现有实现一致。

---

## 2. 厂商私有通道逐一评估（九厂商）

| 厂商 | 私有能力通道 | 公开程度 | 证据 | OPS 可靠性判定 |
|---|---|---|---|---|
| **HP** | JetDirect 私有 SNMP 分支（HP-LASERJET-COMMON-MIB 等，企业 OID 11）；PJL（发明者，官方文档最全）；UPD 驱动；**HPLIP 3.26.4 官方源码全栈（P8 实证）**：hpmud 通道表（9100/9101/9102 打印、9290 系扫描、9220 系通用）、PML→SNMP 双 OID 树映射（Std `1.3.6.1.2.1.43` RFC 3805 + HP `11.2.3.9.4.2`）、Device-ID SNMP OID `11.2.3.9.1.1.7.0`（旧机 community `public.1` 兼容）、**LEDM HTTP XML（/DevMgmt/ProductStatusDyn·ConsumableConfigDyn·MediaHandlingDyn.xml）与 CDM HTTP JSON（/cdm/supply/v1/suppliesPublic）本机端点**、StatusType 13 类动态适配（含 IPP） | **高**（HPLIP 为 HP 官方开源项目，本仓直接源码级实证；MIB 文件可从 mibs.observium.org / HP 官网获取；PJL 官方文档 developers.hp.com） | HP 社区帖（SNMP 墨量实证 + 残缺机型实证）；HP-LASERJET-COMMON-MIB 在线浏览；**HPLIP 源码（本仓 `docs/vendor-evidence/hplip-code/`：pml.py/jd.c/status.py/device.py）** | ✅ **可靠可做（证据升级）**：P4 PJL 已实现；HP 私有 MIB 适配器是下一个最佳候选（页计数/维修件增强）；**P8 新增 HP LEDM/CDM HTTP 适配候选（官方源码实证，优先级与私有 MIB 并列——面向 SNMP 禁用的消费喷墨，响应格式需真机验证）** |
| **Canon** | imageRUNNER SNMP MIB（Canon 门户）；**PIXMA CNCL/ivec XML 状态协议（P8 官方二进制实证）**：`GetStatus`（servicetype=device/maintenance/print）+ `Cleaning`（inkgroup）XML 命令，走 BJNP（UDP 8611）或本机 HTTP（`/canon/ij/command1/port1..2`·`/canon/ij/command2/port1..5`，`Cnmpu2_http` 类）；打印 TCP 9100（`Cnmpu2_port9100`）；PWG Raster 数据格式（tocnpwg） | **中**（imageRUNNER MIB 需门户获取；**PIXMA 通道端口已实证但 ivec XML schema 无公开文档，需真机验证**） | Canon 官方手册「Monitoring and Controlling via SNMP」章节；**cnijfilter2 6.90 官方 deb（本仓 `docs/vendor-evidence/canon-cnijfilter2-6.90-1-deb.tar.gz`：179 PPD + libcnbpcnclapicom2 ivec XML 命令串 + libcnnet2 0x21A3=8611 反汇编）** | ⚠️ **部分可做（证据升级）**：标准 RFC 3805 通道覆盖网络机型；私有 MIB 暂不做（获取渠道不稳定）；**ivec XML 通道列为 Vendor Adapter 候选（官方实证但需真机定 schema）** |
| **Epson** | Status Monitor 3（ESC/I 私有双向协议，USB）；EpsonNet（网络）；**官方 Linux/UOS 驱动核心库双代逆向（P6+P7）**：①新代 libescpr（escpr 1.7.9，L4350 系等 48 型）：网络通道 TCP 9100（`rawGetDefautiPort`=0x238C）+ SNMP 161（community `public`）+ `@EJL 1284.4` 会话，导出墨量/状态/维护 API（`epsGetSupplyInfo`/`epsGetInkInfo`/`epsGetStatus`/`epsMakeMainteCmd`）；②**老代低端 libEpson_201401w（201401w 1.0.0，L130…L455 十二型）：零 socket 导入、零状态 API（仅打印管线 EPC_/JFK_/半色调），代际断崖实证** | **中**（两个驱动 deb 均官方可下：epson.com.cn 驱动页；libescpr 无公开头文件/ABI 文档，但符号与通道反汇编实证；PPD 逐型号能力声明完整） | 驱动包逆向双报告（`docs/vendor-evidence/EPSON_ESCPR_ANALYSIS.md`：48 PPD + libescpr 符号表 + 反汇编；`EPSON_201401W_ANALYSIS.md`：12 PPD 全量交叉审计 + 老代库零网络/零状态结论） | ⚠️ **可研究（作用域限定新代）**：标准 IPP/SNMP 通道照常覆盖；libescpr 私有墨量通道列为 Vendor Adapter 第二优先级候选（排 HP/Lexmark 公开 MIB 之后，**仅覆盖新代机型**）——**无真机抓包不开发、不宣称**；**老代 L 系列（L130/L220/L310/L360/L365/L455 等）耗材 IPP/SNMP 读不到即 UNKNOWN 终态（官方能力边界）**；双数据点（P6 同代跨型号差异 + P7 跨代际断崖）二次正交验证「能力逐型号声明」——L4350 双面长短边/720dpi/无 InputSlot vs 老代 12 型全无双面/无 InputSlot/有 Borderless/16 纸型/分辨率绑介质 |
| **Brother** | PJL INFO SUPPLY 变体（「隐藏 OEM 命令」）；私有 OID；**hll2350dwpdrv 4.0.0 官方 deb（P8 实证）**：rawtobr3 输出完整 PJL 流（UEL + @PJL JOB/EOJ/SET + SET OUTBIN=OPTIONALOUTPUTBIN1..4）；PPD 真实声明（Throughput=18、InputSlot Manual+Tray1、Duplex 三值、Resolution 4 档）；官方能力文件 brHLL2350DWfunc（Copies 1-999/TonerSave/Sleep）；**官方安装器网络默认 lpd://IP/BINARY_P1** | **中高**（SNMP OID 有官方 MIB + HA 官方集成实证；PJL 语言层使用官方实证；**SUPPLY 查询响应格式仍需真机**；官方 deb 可下：support.brother.com） | Kapua 博客（toner levels 需 trawl 互联网找 OEM 命令）；serverfault Brother 9460 帖；**官方 deb（本仓 `docs/vendor-evidence/brother-hll2350dwpdrv-4.0.0-1.i386.deb` + PPD + func + 安装器脚本）** | ⚠️ **试点已做、证据升级**：P4 的 SUPPLY 解析即 Brother 风格试点（PJL 语言层官方背书）；无真机验证前**不得**宣称支持；**「Linux 官方默认 9100」已修正为 LPD BINARY_P1（9100 为设备侧通用支持）** |
| **Xerox** | CentreWare EWS；MIB 文件 | **中**（Home Assistant 社区实证标准 SNMP 四色碳粉+页计数可读；私有 MIB 分散） | HA 社区帖（SNMP 全部四色 OK）；PRTG KB（用户自寻 MIB） | ✅ **标准通道可靠**；私有增强暂不做 |
| **Ricoh** | 私有 MIB（官网 RiDP 门户 **NDA 下载**） | **低**（需签 NDA） | Reddit sysadmin 帖（明示 NDA 流程） | ❌ **不可做**（合规边界：NDA 代码不能进开源项目）；标准 RFC 3805 通道照常覆盖 |
| **Kyocera** | KMnetViewer 管理工具的私有 MIB | **低**（未公开） | 无公开 MIB 下载渠道 | ❌ 暂不做；标准通道覆盖 |
| **Konica Minolta** | PageScope 私有接口 | **低**（未公开） | 同上 | ❌ 暂不做；标准通道覆盖 |
| **Lexmark** | LEXMARK-MPS-MIB 等公开 MIB 族；**消费线 NPA 私有双向协议（P8 历史实证，2009）**：NpaProtocol/NPA407Comm 类走 USBLP_PORT（inkjet-08 驱动） | **高**（企业线：官方文档 + MIB 公开可下载；官方文档明确 RFC 1759/3805 支持；**消费线 NPA 为历史私有路线，与现代企业 MIB 双轨**） | support.lexmark.com「SNMP MIB and OID Values Explained」；LEXMARK-MPS-MIB 在线浏览；**官方驱动（P8：lx2600.ppd + NPA 类名归档）** | ✅ **可靠可做**：与 HP 并列的下一个 Vendor Adapter 候选（企业线）；消费线 host-based 归 cups/windows 后端兑底 |

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

1. ~~**Windows DeviceCapabilities API 适配**~~ **✅ P5 已完成（v0.4.3）**：`src/backends/devicecaps.ts`（Add-Type P/Invoke 单次查询 5 项）+ windows.ts 双层能力（WMI 基线 → DC 只提升 UNKNOWN）+ paperTrays 能力轴（前后端 + merge）+ 45s 枚举缓存 + 场景 21 platform-runtime 平台守卫 + PDF 临时文件提交修复。真机验收待 Windows 硬件。
2. ~~**HP LEDM/CDM HTTP 适配器**~~ ✅ **已完成（P9 · v0.4.7）**：LEDM :8080 XML 三文档（ProductStatusDyn/ConsumableConfigDyn/MediaHandlingDyn）+ CDM :80 JSON（suppliesPublic）双通道只读探测落地（Virtual LEDM :3068 + 场景 22 全链路 + 404→UNKNOWN 兜底回归）；真实 HP 机型响应细节以实测为准（无真机不宣称格式细节）。
3. **HP 私有 MIB 适配器**（HP-LASERJET-COMMON-MIB 公开）——维修件计数/页计数/纸盒增强。
4. **Lexmark MIB 适配器**（官方文档 + LEXMARK-MPS-MIB 公开）——同上并列。
5. **Brother PJL SUPPLY 真机抓包适配**——PJL 语言层使用已获官方驱动实证（UEL+@PJL SET），需真机验证 INFO 响应格式。
6. **Epson libescpr 状态通道适配器（作用域仅新代机型）**——需真机抓包定 ABI，无真机不开发。
7. **Canon ivec XML 状态通道（P8 新增候选）**：PIXMA GetStatus/Cleaning XML 命令已实证，schema 需真机验证（优先级排在 HP/Lexmark 公开 MIB 之后）。
8. **不做**：Ricoh NDA MIB、Kyocera/KM 私有接口、任何 EWS 网页抓取（脆弱且非契约）。

---

## 6. 参考来源（本轮检索 2026-09）

- RFC 3805 / RFC 1759（Printer MIB）/ RFC 2790（HOST-RESOURCES）/ RFC 8010/8011（IPP）/ RFC 3380
- IANA「Internet Printing Protocol (IPP) Registrations」；PWG IPP Guide（istopwg.github.io）
- Microsoft Learn：Win32_Printer、DeviceCapabilitiesA（wingdi.h）、DEVMODEA、DocumentProperties
- developers.hp.com「HP Printer Command Languages: PJL」
- Lexmark support「SNMP MIB and OID Values Explained」；mibs.observium.org（HP-LASERJET-COMMON-MIB / LEXMARK-MPS-MIB / Printer-MIB 浏览）
- HP 社区（h30434.www3.hp.com：SNMP 墨量实证与 4301 缺失实证）；Canon 官方手册（SNMP 监控章节）；Epson 官方（Status Monitor 3 文档）
- **多品牌官方驱动逆向（P8 第三轮，2025-09，Brother/HP/Canon/Lexmark）**：①`brother-hll2350dwpdrv-4.0.0-1.i386.deb`（support.brother.com → download.brother.com/welcome/dlf103566，HL-L2350DW 官方驱动）→ PPD/能力文件/PJL 流实证 + 官方安装器 LPD BINARY_P1 默认；②HPLIP 3.26.4 上游源码（SourceForge 403 → deb.debian.org 归档）→ hpmud 端口表/PML-SNMP OID/LEDM/CDM HTTP 端点全实证；③`cnijfilter2-6.90-1-deb.tar.gz`（gdlp01.c-wss.com 直链）→ 179 PPD + Cnmpu2_port9100 + BJNP 8611 + ivec XML 状态命令；④Lexmark inkjet-08（downloads.lexmark.com）→ NPA 私有协议 + host-based。证据归档 `docs/vendor-evidence/`（MULTI_BRAND_DRIVERS_ANALYSIS.md + 各包/关键源文件）；Kyocera 下载中心纯 JS 无直链，本轮诚实未获取。
- **Epson 官方驱动逆向（P6，2025-09）**：`signed_epson-inkjet-printer-escpr_1.7.9_amd64.deb`（epson.com.cn 驱动页下载）→ PPD 逐型号能力声明 + libescpr 导出符号（`nm -D`）+ 端口反汇编（`objdump` rawGetDefautiPort=0x238C）；证据归档 `docs/vendor-evidence/`（EPSON_ESCPR_ANALYSIS.md + 原 deb + L4350 PPD）
- **Epson 官方驱动逆向（P7 第二轮，2025-09，低端机型）**：`epson-inkjet-printer-201401w_1.0.0_amd64.deb`（同页系下载，适用 L130/L220/L310/L360/L365/L455 等）→ 12 PPD 全量交叉审计（无 Duplex/无 InputSlot/有 Borderless/16 纸型/4 介质/分辨率绑介质 360·720）+ 老代核心库逆向（零 socket 导入、零 epsGet* 状态 API、资源签名校验机制）；证据归档 `docs/vendor-evidence/`（EPSON_201401W_ANALYSIS.md + 原 deb + L360 PPD）——与新代形成**代际断崖**对照，划定 libescpr 适配器作用域
- 社区实证：serverfault（页计数/Brother OID）、Reddit sysadmin（Ricoh NDA 流程）、Home Assistant（Xerox 四色实证）、Kapua 博客（Brother PJL SUPPLY）、RUB-NDS PRET（PJL 工具实现）
