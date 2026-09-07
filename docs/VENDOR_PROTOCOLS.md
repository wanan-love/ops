# 主流打印机厂商驱动与通信协议对比研究

> Task ID: P5 · 纯研究文档（未修改任何代码）
> 研究方法：PWG/RFC 标准公开文本 + 厂商公开支持文档 + 开源生态（CUPS/OpenPrinting/sane-airscan 等）公开资料 + web 检索交叉验证（检索日期 2026-09）。
> **型号覆盖度声明：本文基于公开资料整理，各厂商具体型号的支持矩阵差异极大，一切结论以实际设备探测（Get-Printer-Attributes / SNMP walk / mDNS TXT）为准。**

---

## 1. 研究目的与结论摘要

**目的**：验证 OpenPrintShare v0.3.x 的后端技术选型——「CUPS + IPP（Everywhere）+ Windows Printing API + SNMP(RFC 3805) + mDNS/DNS-SD」——是否足以覆盖主流厂商局域网打印机的发现、打印、状态、能力与耗材读取需求，并识别必须引入厂商专用适配（Vendor Adapter）的能力边界。

**一段话结论**：该选型与整个行业的「driverless printing」演进方向（CUPS ≥2.2 临时队列、Windows Mopria/Universal Print、AirPrint）完全一致，**打印提交、队列/进度、基础状态（缺纸/卡纸/离线）、能力协商（彩色/双面/份数/纸张）这四类需求在 2012 年后的主流网络打印机上覆盖率可达 90% 以上**；耗材（墨量/碳粉）读取是最大的长尾——IPP `marker-levels` 覆盖有限且常返回非精确值，SNMP RFC 3805 `prtMarkerSupplies` 是事实上的最大公约数但消费级机型实现残缺、且新固件常默认关闭 SNMP；扫描（eSCL）与固件细节、墨盒芯片精确计数等必须引入额外协议层。**当前架构无需推翻，只需按第 7 节路线图补齐「标准协议的二级来源」与「Vendor Adapter 插件层」。**

---

## 2. 标准协议能力矩阵

| 协议 | 发现 | 打印提交 | 能力协商（颜色/双面/纸张/份数/分辨率） | 状态（缺纸/卡纸/离线/忙碌） | 耗材/墨量 | 任务进度 | 备注（读不到什么） |
|---|---|---|---|---|---|---|---|
| **IPP**（RFC 8010/8011，Get-Printer-Attributes / Print-Job / Get-Jobs / Cancel-Job） | 否（靠 DNS-SD） | ✅ PDF/URF/PWG-Raster | ✅ `color-supported`、`sides-supported`、`media-supported`、`copies-supported`、`printer-resolution-supported`、`printer-pages-per-minute` | ✅ `printer-state`(3/4/5) + `printer-state-reasons`（`media-needed`/`media-jam`/`shutdown`/`timed-out` 等 keyword） | ⚠️ 部分：`marker-levels` / `marker-types` / `marker-names` / `marker-colors`（取值 −3..100，−3=unknown、−2=有剩余但非精确、−1 依标准为 other；很多机型不返回或只回粗粒度档位） | ✅ `job-state` + `job-impressions-completed`（OPS 已实现） | 扫描、固件版本细节、墨盒芯片原始计数、页数总计数器（IPP 无强制页计数属性；页计数需 SNMP `prtMarkerLifeCount`，见下行） |
| **SNMP**（RFC 3805 Printer-MIB v2，UDP 161） | 否 | 否（仅老式 LPD 旁路） | ⚠️ 弱：`prtMediaTable`/`prtInputTable`（介质/纸盒，printmib 43 分支，具体子树以 RFC 3805 文本为准）、`prtMarkerColorantTable`（色材）；非完整能力协商用途 | ✅ `hrPrinterDetectedErrorState`（HOST-RESOURCES-MIB 1.3.6.1.2.1.25.3.5.1.2 位掩码：lowPaper/noPaper/jam/…）+ `prtAlertTable`（43.18） | ✅ **最大公约数**：`prtMarkerSuppliesLevel`（**1.3.6.1.2.1.43.11.1.1.9**，−3/−2/−1..100）+ `prtMarkerSuppliesType`（.5：toner=3/ink=4/…）+ `prtMarkerSuppliesDescription`（.6）+ `prtMarkerSuppliesMaxCapacity`（.8） | ❌（无打印任务进度概念） | v1/v2c 明文 community；新固件常默认禁用；无法打印、无 job 模型；页面计数需 `prtMarkerLifeCount`（43.10.1.1.x） |
| **WSD**（Web Services on Devices，WS-Discovery + WS-Print/WS-Print v2，OASIS 标准） | ✅ UDP SOAP 组播 | ✅（Windows WSD 端口监视器） | ⚠️ WS-Print v1 基本设备信息；v2 扩展（很少有机型实现 v2） | ⚠️ 有限（元素级 printer status，可靠性口碑差于 TCP 直连，社区证据一致） | ❌（v1 无耗材；v2 增加了部分状态但部署罕见） | ⚠️ 弱 | 与 OPS 关系：Windows 宿主上 WSD 队列仍可被 Windows Printing API 兜底；OPS 无需自研 WSD 客户端 |
| **mDNS/DNS-SD**（RFC 6762/6763） | ✅ `_ipp._tcp` / `_ipps._tcp`（+ TXT `rp`/`ty`/`pdl`/`adminurl`）；AirPrint 子类型 **`_universal._sub._ipp._tcp`**；另有 `_pdl-datastream._tcp`(9100)、`_printer._tcp`(LPD 515)、扫描 `_uscan._tcp`/`_scanner._tcp` | 否（仅广告） | ⚠️ 仅从 TXT `pdl`（支持的文档格式列表）推断 | 否 | 否 | 否 | OPS 已实现 PTR/SRV/TXT/A 解析（Task 2-b）；建议补充识别 `_universal._sub` AirPrint 子类型与 `pdl` 中 `image/urf`、`image/pwg-raster`、`application/pdf` 判定 driverless |
| **Windows Printing API**（Win32 spooler：EnumPrinters/GetPrinter/JOB_INFO + WMI Win32_Printer/Win32_PrintJob + Bidi IBidiSpl2） | ✅（本机已装队列；网络发现靠 OS） | ✅（任意驱动队列，含 legacy host-based） | ✅（DEVMODE/驱动 DEVCAPS——来自厂商驱动而非打印机本体） | ✅ PRINTER_INFO_2.pPrinterStatus + spooler 队列状态；真实设备状态取决于端口监视器（标准 TCP/IP 端口监视器默认走 **SNMP RFC 3805** 读取状态/耗材，厂商端口监视器走私有 Bidi） | ⚠️ 无公开 Win32/WMI 墨量接口；`Win32_Toner` 等非标准类；墨量仅存在于厂商驱动 UI / Bidi 扩展 / SNMP | ✅（JOB_INFO_2 状态+页数） | 需要预装驱动；墨量本质上还是回到 SNMP/私有协议 |
| **CUPS**（macOS/Linux 宿主） | ✅ Bonjour/mDNS | ✅ | ✅（cups-filters / PPD / IPP 属性） | ✅ | ⚠️ CUPS 自身读取 IPP `marker-*` 展示（网页管理界面 Supply Levels），无 IPP 属性时无耗材 | ✅（`lpstat`/job 事件） | OPS 已实现 cups 后端（lp/lpstat/cancel）；legacy 驱动机型由 CUPS 过滤器链兜底 |

**关键洞见**：五条标准通道**互为补充且几乎无一家独占**——发现靠 mDNS/WSD、打印靠 IPP/9100/系统队列、状态靠 IPP reasons + SNMP、耗材靠 SNMP(RFC 3805) > IPP(marker-*) > 供应商私有。这正是 OPS「能力三态 + 多来源 probe + merge」架构的正确性依据：任何单一协议读不到 ≠ 不支持。

---

## 3. 厂商对比表

通用协议支持列指「该品牌当前在售主流网络机型对 IPP Everywhere / AirPrint（即 IPP+DNS-SD+PDF/URF/PWG-Raster driverless）的典型支持情况」；✅=普遍 / ⚠️=部分（分产品线） / ❌=罕见。私有 OID 值**本文一律不列具体编号**（公开资料未标准化的，需厂商 MIB 文件或实际抓包确认）。

| 品牌 | 典型型号系列 | IPP Everywhere/AirPrint | 私有协议/驱动语言 | 墨量·耗材读取（协议 + 数据来源） | 对 OpenPrintShare 的意义/限制 |
|---|---|---|---|---|---|
| **HP** | LaserJet Pro/MFP、OfficeJet Pro、PageWide | ✅（新机型普遍，PWG 自认证列表常客） | PCL 5/6、PJL；**JetDirect/AppSocket RAW 9100 端口发明者（1992）**；**HPLIP 3.26.4 官方源码实证（P8，`docs/vendor-evidence/MULTI_BRAND_DRIVERS_ANALYSIS.md` §2）**：hpmud JetDirect 通道表 9100/9101/9102（打印）、9290/9291/9292（扫描）、9220/9221/9222（通用）；UPD 端口监视器；私有 SNMP 分支（企业 OID 树，MIB 可从官网下载） | ① SNMP RFC 3805 `prtMarkerSuppliesLevel`（多数 LaserJet 支持，但入门级/老机型 General 表残缺——社区实证如 LaserJet P2035n 未完整实现 RFC 3805）② IPP `marker-levels`（driverless 机型）③ **HPLIP 官方代码五通道并存（P8 实证）**：PML→SNMP（Std MIB `1.3.6.1.2.1.43.11.1.1.5.1.x` marker supplies + HP 私有树 `11.2.3.9.4.2`）、Device-ID SNMP OID `11.2.3.9.1.1.7.0`（旧机 community `public.1` 重试）、**LEDM HTTP XML `/DevMgmt/ProductStatusDyn.xml`·`ConsumableConfigDyn.xml`·`MediaHandlingDyn.xml`**、**CDM HTTP JSON `/cdm/supply/v1/suppliesPublic`**、IPP（StatusType 13 类动态适配） | IPP 路线友好；SNMP 大体可用但必须容忍残缺；9100 是兜底打印通道（HP 官方源码正面实证）；HP Smart 云端无公开局域网墨量 API，但**官方 HPLIP 证明部分机型本机 HTTP LEDM/CDM 端点存在（局域网）**——✅ P9 已落地 Vendor Adapter（v0.4.7：LEDM :8080 XML 三文档 + CDM :80 JSON 只读探测，场景 22 全链路验证；真实机型响应细节以实测为准） |
| **Canon** | PIXMA/MAXIFY（消费）、imageCLASS、imageRUNNER/iR ADVANCE（办公） | ⚠️（新 PIXMA 与 iR 系列普遍；办公高端常默认关） | **CAPT**（旧 LaserShot 主机端渲染）、**UFR II/UFR II Lite**（现行私有渲染）、可选 PCL/PS；**PIXMA cnijfilter2 6.90 官方驱动实证（P8）**：打印走 `Cnmpu2_port9100` 通道类（TCP 9100）+ BJNP UDP 8611 发现（libcnnet2 反汇编 0x21A3）+ 本机 HTTP 命令端口族 `/canon/ij/command1/port1..2`·`/canon/ij/command2/port1..5`（`Cnmpu2_http` 类）；数据格式双路 tocanonij（经典）/tocnpwg（**PWG Raster**）；179 PPD 全家族 Duplex 三值、无 InputSlot、600dpi 单档、Throughput 占位 1 | ① IPP `marker-levels`（AirPrint 机型）② SNMP RFC 3805 `prtMarkerSupplies*`（iR 办公线较好，PIXMA 消费线常缺失或非精确——需实测）③ **PIXMA 官方状态协议实证（P8，libcnbpcnclapicom2 逆向）**：CNCL API → ivec XML（`http://www.canon.com/ns/cmd/2008/07/common/` 命名空间）`GetStatus`（servicetype=device/maintenance/print）+ `Cleaning`（inkgroup）命令，cnijlgmon3 为官方 Linux 状态监视器；`CLSS_IsSupportBJNP_From14Autumn`（2014 秋季起标志） | CAPT/UFR II 机型 host 端渲染 → 无法用 IPP driverless，必须走宿主 CUPS/Windows 驱动队列（OPS 的 cups/windows 后端正好兜住）；消费级耗材读取长尾重灾区（BJNP 端口口径已从「社区口径不一」升级为官方实证；**ivec XML 响应 schema 无公开文档，需真机验证，列为 Vendor Adapter 候选**） |
| **Epson** | EcoTank/Expression/WorkForce（喷墨）、AcuLaser（激光，现部分归收购方） | ✅（新机型普遍） | **ESC/P、ESC/P-R**（栅格化变体，开源驱动 `epson-inkjet-printer-escpr`；其核心库 `libescpr` 网络通道反汇编实证走 **TCP 9100**（`rawGetDefautiPort` 返回 0x238C）+ **SNMP 161**（community `public`）+ `@EJL 1284.4` 设备 ID 会话，见 `docs/vendor-evidence/EPSON_ESCPR_ANALYSIS.md`）；**代际断崖（P7 逆向实证，`docs/vendor-evidence/EPSON_201401W_ANALYSIS.md`）**：低端老代（L130/L220/L310/L360/L365/L455 等 12 型，驱动 `epson-inkjet-printer-201401w`）核心库 **零 socket 导入、零状态 API**（无 epsGet* 家族，仅打印管线）——私有状态通道仅存在于新代 libescpr；Epson Status Monitor 私有双向状态；**Epson Connect 云 API（公开 REST，developer.epsonconnect.com，但纯云端，不提供局域网墨量）** | ① IPP `marker-levels`（AirPrint 机型）② SNMP RFC 3805 `prtMarkerSupplies*`（真机支持面未验证——新代官方 UOS 驱动库自身依赖 SNMP/9100 双通道做发现与探测，说明网络栈存在，但具体型号 marker 表覆盖率无公开资料，以实际探测为准）③ **官方库私有 API（仅新代，逆向实证）**：`libescpr.so` 导出 `epsGetSupplyInfo`/`epsGetInkInfo`/`epsGetStatus`/`epsMakeMainteCmd`（清洗）/`epsGetSupportedMedia`，但无公开头文件/ABI 文档，需真机抓包才能适配；**老代 201401w 库无任何等价物，Linux 侧官方自身不提供读取通道** | ESC/P-R 开源驱动实证「IPP 之外的裸 9100 + 栅格数据」路线可行（L4350 PPD：双面长/短边、720dpi 上限、12 纸型+无边距、无 InputSlot）；**老代 12 型 PPD 全量审计：无 Duplex、无 InputSlot、有 Borderless、16 纸型、分辨率绑介质（360/720）**——「能力逐型号/逐代际声明」双数据点验证，按品牌或系列推断必错；Epson Connect API 与 OPS 无交集（云≠LAN）；墨量最佳期望仍是 IPP+SNMP 双 probe，libescpr 私有通道列为第二优先级 Vendor Adapter 候选（**作用域限定新代机型**；老代读不到即 UNKNOWN 终态——官方能力边界，非缺陷） |
| **Brother** | MFC/DCP/HL/ADS、QL 标签 | ✅（PWG 自认证列表中 Brother 型号众多，pwg.org/printers 首屏即多款 MFC-J；Mopria 普及） | PJL + PCL（开源 `brlaser`/`brgenml` 驱动）、BR-Script（PS Level 3 兼容）；**hll2350dwpdrv 4.0.0 官方 deb 实证（P8）**：rawtobr3 输出完整 PJL 流（UEL + `@PJL JOB/EOJ/SET`，SET OUTBIN=OPTIONALOUTPUTBIN1..4 出纸槽）；**官方 linux-brprinter-installer 网络默认 `lpd://IP/BINARY_P1`（515）非 9100**（USB 优先 usb://；9100 为设备侧通用支持） | ① **SNMP RFC 3805 `prtMarkerSuppliesLevel`（1.3.6.1.2.1.43.11.1.1.9）**：Brother 公布 MIB，Home Assistant 官方 Brother 集成即用此 OID 读墨量（公开生态强实证）② IPP `marker-levels`（driverless 机型）③ PJL 状态回读（`@PJL INFO` 类命令走 9100 双向通道：**Brother 官方驱动 PJL 语言使用已实证，INFO 查询命令格式仍需真机抓包**） | **对 OPS 最友好的品牌**：SNMP 标准路线实测可用度高；PJL 双向通道获官方语言层背书（P4 试点价值强化）；PPD 声明真实（Throughput=18 真实值、InputSlot Manual+Tray1、Duplex 三值、Resolution 4 档 300/600/1200/HQ1200、brHLL2350DWfunc 官方能力文件 Copies 1-999/TonerSave/Sleep） |
| **Xerox** | Phaser、WorkCentre、AltaLink | ⚠️（企业部署常默认关闭 AirPrint——OpenPrinting/cups #1292 讨论：CUPS 仅在 AirPrint 开启时为其建临时队列） | PostScript/PCL 原生；Xerox 全球打印驱动 | ① SNMP RFC 3805（企业机强）② IPP `marker-*`（开启 AirPrint 后）③ 私有 CentreWare/EWS 页面（无公开 API） | 高端 PS 机型 IPP 直打质量最好；发现不到时先怀疑「AirPrint 被管理员关闭」，应提示用户在 EWS 开启 |
| **Ricoh** | IMC/IM 系列（原 Aficio） | ⚠️（新 IM 系列支持，企业管理端常关） | **RPCS**（旧私有）、PCL5/6、PS3（可选）；当前通用驱动 PCL/PS | ① SNMP RFC 3805（企业机完善，含维修件计数）② IPP `marker-*` ③ Smart Device Connector 私有 | 企业租机型占主流 → SNMP 是主通道；需处理 community 非默认值 |
| **Kyocera** | ECOSYS、TASKalfa | ⚠️→✅（新机型 AirPrint/Mopria；企业默认态不一） | **PRESCRIBE**（旧私有 PDL）、KX 驱动（PCL6/PS/PDF 直打） | ① SNMP RFC 3805（企业机完善，Kyocera 公布 MIB，含 OPC/鼓等维修件计数）② IPP `marker-*` | PDF 直打能力（`pdl` 含 application/pdf）意味着 IPP Print-Job 可以省栅格化，值得 OPS 后续利用 |
| **Konica Minolta** | bizhub C/i 系列 | ⚠️（新 bizhub 支持；微软 Universal Print 兼容列表在列） | PCL/PS 通用驱动、旧 PageScope 私有管理 | ① SNMP RFC 3805（企业机完善）② IPP `marker-*` | 同 Ricoh/Kyocera 企业画像 |
| **Lexmark** | MS/MX/XM/CX 系列 | ✅（现代企业机型 AirPrint/IPP Everywhere 支持最激进的一档） | PCL/PPDS/PCL XL/PS；9100+IPP 双通道；**消费线 inkjet-08 官方驱动实证（P8，2009）**：host-based 专有渲染器（cupsFilter→bin/printdriver）+ **NPA 私有双向协议**（NpaProtocol/NPA407Comm 类走 USBLP_PORT）做状态/命令通道 | ① SNMP RFC 3805（**企业级最强**：MarkVision Enterprise 即基于 SNMP+HTTP 管理，MIB 公开）② IPP `marker-*`（覆盖好）③ 消费机 NPA over USB（历史证据） | 耗材读取期望值最高的品牌；可作为「标准协议上限」的基准测试机；消费线 host-based+私有 NPA 与企业线公开 MIB 形成厂商内部双轨（P8 实证补充） |
| **其它主流** | Samsung（并入 HP）、Toshiba e-STUDIO、Sharp、OKI、Dell（贴牌）、Fujifilm（原富士施乐）、Zebra（标签） | 三星新机✅；东芝/夏普⚠️（Mopria 成员为主）；OKI⚠️ | 三星 SPL；东芝私有+PCL/PS；OKI PCL/PS | 多数遵循 SNMP RFC 3805 + IPP `marker-*` 双通道；细节公开资料未标准化，需实测 | Mopria 联盟称认证设备 1.2 亿+台，Android/Windows 原生 driverless 均基于 IPP 体系 → 印证 OPS 的 IPP 主路线 |

**横向规律**（对 OPS 的战略含义）：

1. **企业 A3 一体机**（Ricoh/Kyocera/KM/Xerox/Lexmark/Toshiba）：SNMP RFC 3805 完善但 IPP 可能被管理员关闭 → SNMP 优先、IPP 兜底，community 字符串要可配置。
2. **消费/SOHO**（HP/Canon/Epson/Brother）：AirPrint 普及但 SNMP 常缺失或禁用 → IPP `marker-*` 优先、SNMP 兜底，双向 9100 PJL 是潜在第三来源（P8 官方证据：HP LEDM/CDM HTTP、Canon ivec XML/BJNP 8611、Epson libescpr——**三家私有状态通道均已升级为「官方代码级实证，需真机验证格式」候选**）。
3. **legacy host-based**（CAPT/UFR II/SPL/GDI）：无网络渲染能力 → 唯一出路是宿主已装驱动的队列（OPS cups/windows 后端），OPS 不应试图自研。

---

## 4. 标准协议无法获取（或不可靠）的能力清单

| # | 能力 | 标准协议现状 | 是否必须厂商专用 |
|---|---|---|---|
| 1 | **扫描**（MFP） | IPP-Scan（PWG 规范）存在但部署罕见；**eSCL（Apple AirScan，HTTP REST）已是事实标准**，sane-airscan 开源实现同时覆盖 eSCL + WSD-Scan；`_uscan._tcp`/`_scanner._tcp` 可发现 | **半标准**：走 eSCL 即可覆盖 AirPrint 认证的 MFP；非 AirPrint 老机型需厂商私有（TWAIN over 网络/各私有协议）。标准协议，**OPS 已实现 ✅（v0.3.2：eSCL 客户端 + _uscan 发现，PNG 多页）** |
| 2 | **固件版本/序列号细节** | IPP 无强制属性（部分机型回 `printer-uuid`/`printer-firmware-string` 非标准）；SNMP `prtGeneralSerialNumber`（43.5.1.1.1 一带）可选实现 | 混合：SNMP 常可得，属「尽力而为」 |
| 3 | **墨盒芯片原始计数**（已打印页数/剩余页数/区域码/芯片认证状态） | 无任何标准承载；厂商云与私有通道才有 | **必须 Vendor Adapter / 不可达**（多数只在机身 UI 与厂商云可见） |
| 4 | **耗材精确克重/剩余寿命（非百分比）** | IPP/SNMP 均只有百分比或 −2 粗档；维护件（fuser/OPC/waste toner）在 Printer-MIB 中可表达但厂商选择性暴露 | 混合：SNMP 拿得到就标准，拿不到只能私有 |
| 5 | **扫描到云/云打印编排** | 无 | 厂商云 API（Epson Connect 等公开但纯云端）；与 OPS LAN 定位正交，建议明确不做 |
| 6 | **打印质量/色彩管理微调**（ICM 色彩配置、专色） | IPP 无 | 厂商驱动能力；OPS 通过 options 透传即可，不深究 |
| 7 | **HP 打印安全/固件策略、墨水订阅状态** | 无 | 厂商云私有，明确不做 |
| 8 | **WSD v2 增强状态** | 部署罕见 | 不值得做 |
| 9 | **ipps:// TLS 打印** | 标准存在（RFC 8011 + IPP/2.x over HTTPS），但自签证书链处理是实际痛点 | 标准协议，OPS 已实现 ✅（ipps://（TLS 自签容忍）） |

---

## 5. 厂商驱动实际使用的通信方式分析

**结论先行：现代厂商驱动的数据通道收敛为「RAW 9100 双向流」或「IPP」，状态/耗材通道收敛为「SNMP」或「私有双向协议」，发现通道收敛为「mDNS/WSD」。**

| 厂商驱动形态 | 数据通道 | 状态/耗材通道 | 说明 |
|---|---|---|---|
| Windows 厂商驱动（HP UPD、Canon UFR II、Epson、Brother、KX 等） | 端口监视器 → 多数默认 **RAW 9100**（HP JetDirect/AppSocket 血统，几乎被全体网络打印机采纳）；也支持 LPR 515、 IPP 631、WSD | ① Windows 标准 TCP/IP 端口监视器可开启 **SNMP（RFC 3805 套件）** 读状态 ② 厂商端口监视器走私有 Bidi（PJL 回读/BJNP/Status Monitor 协议） | 「9100 是事实上的打印通用端口」为 Pentesting/PaperCut/厂商文档多方共识；HP 社区亦确认 9100 源自 HP 1992 年 JetDirect |
| macOS 厂商驱动 | 同上（9100/IPP），或 IOPM 插件 | 同上 | macOS 同时原生 AirPrint（IPP+mDNS），驱动仅为增强 |
| Linux 厂商/开源驱动 | CUPS 后端：`socket`(9100) / `ipp` / `lpd`；过滤链输出 PCL/ESC/P-R/PWG-Raster | CUPS 从 IPP `marker-*` 取耗材（网页界面）；命令行生态用 SNMP | OpenPrinting 数据库+ foomatic 记录各机型驱动路由；**多品牌官方 Linux 驱动已逆向实证（P6-P8，`docs/vendor-evidence/`）**：Epson escpr（9100+SNMP161、墨量 API 无公开 ABI、代际断崖）；Brother pdrv（PJL 流 UEL+@PJL SET，安装器默认 LPD BINARY_P1）；HP HPLIP 源码（9100/9101/9102、PML→RFC 3805、LEDM/CDM HTTP、Device-ID SNMP OID）；Canon cnijfilter2（Cnmpu2_port9100、BJNP UDP 8611、ivec XML GetStatus、HTTP /canon/ij/command*）；Lexmark inkjet-08（host-based + NPA over USBLP） |
| Mobile（iOS/Android 原生打印） | **一律 IPP（Print-Job）+ mDNS 发现**，数据格式 URF（iOS）/PWG-Raster+PDF（Mopria/Android） | 无墨量（系统不展示耗材） | AirPrint/Mopria 体系 = OPS driverless 路线的直接对标物 |
| 企业管理（MarkVision/Lexmark、Kyocera Net Viewer、RICOH Device Manager） | — | **SNMP 为主 + EWS(HTML/REST) 为辅** | 印证 SNMP 在企业侧不可替代 |

**对 OPS 的直接推论**：OPS 的 IPP 主通道 = 站在 Mopria/AirPrint 同一条标准带上；SNMP = 与企业管理软件同一条带；9100 可作为未来「最后一公里」兜底（仅 raw 透传，无状态回读标准）。**没有任何主流厂商的驱动把 WSD 作为主数据通道**——OPS 不实现 WSD 打印是正确取舍。

---

## 6. 每项能力「标准可替代性」判断

| 能力 | 判断 | 依据 |
|---|---|---|
| 发现打印机 | **标准可获取**（mDNS/DNS-SD；Windows 上 OS 自带 mDNS+WSD 双发现） | `_ipp._tcp`/`_universal._sub` 全生态支持 |
| 提交打印 + 选项（份数/双面/纸张/彩色） | **标准可获取**（IPP Print-Job + job-template 属性）≈ 90% 现役网络机型 | Mopria 1.2 亿认证 + AirPrint + CUPS 临时队列生态 |
| 队列状态与进度 | **标准可获取**（IPP job-state/job-impressions-completed；Windows JOB_INFO；CUPS） | OPS 已验证（vipp + 真机待验） |
| 打印机条件状态（缺纸/卡纸/离线） | **标准可获取**（IPP `printer-state-reasons` keyword + SNMP `hrPrinterDetectedErrorState`） | keyword 列表为 RFC 8011 标准内容 |
| 能力协商（color/duplex/media/copies/dpi/ppm） | **标准可获取**（IPP Get-Printer-Attributes；Windows DEVMODE 兜底 legacy） | OPS `reportFromPrinterAttributes` 已覆盖全部七项 |
| **墨量/耗材百分比** | **混合**：IPP `marker-*`（新机）+ SNMP `prtMarkerSuppliesLevel`（企业/兄弟等）覆盖大多数；剩余长尾（消费喷墨禁 SNMP 且 IPP 不回 marker）→ **必须 Vendor Adapter 或 UI 隐藏** | 厂商对比表第 5 列 |
| 耗材低量告警 | **标准可获取**（IPP `printer-state-reasons` 的 `toner-low`/`ink-low` 等 keyword——很多机型即使不给 level 也会给 keyword） | 建议 OPS 补充解析该 keyword 作为耗材降级信号 |
| 扫描 | **半标准**（eSCL 覆盖 AirPrint MFP；老机必须厂商私有）。**OPS 已实现基础扫描 ✅（v0.3.2：eSCL HTTP+XML 客户端 + _uscan._tcp mDNS 发现 + PNG 多页 + 取销）**；PDF 合成/双面/DFE 留后续 | sane-airscan 生态成熟；真实扫描仪待硬件验证 |
| 固件/序列号 | **混合**（SNMP 尽力而为） | prtGeneral 表可选实现 |
| 墨盒芯片精确计数 | **必须 Vendor Adapter**（且多数无网络暴露面） | 无标准承载 |
| 厂商云能力（Epson Connect/HP Smart） | **不可达/不做** | 公开 API 均纯云端，与 LAN 架构正交 |

---

## 7. Vendor Adapter 路线图建议（不破坏通用架构）

### 7.1 架构原则

1. **适配层只做「增强」，不做「替代」**：沿用现有 `CapabilityReport` 四元组（value/state/source/detail）与 merge 语义——Vendor Adapter 的产出只能是「把 UNKNOWN 提升为 SUPPORTED」，绝不覆盖 IPP/SNMP 已有 SUPPORTED 值；source 记为 `vendor:<id>` 以保持来源可审计。
2. **厂商识别走标准信号**：`printer-make-and-model`（IPP）+ mDNS TXT `ty`/`mfg`/`mdl` + SNMP `sysObjectID`（enterprise 分支即厂商编号，无需私有 OID 知识）→ `detect(): confidence`，不依赖 IP 猜测。
3. **通道优先级固定**：`IPP → SNMP(RFC 3805) → HOST-RESOURCES-MIB → 厂商专用（PJL over 9100 / 厂商 MIB）`，任何一步失败只记 probe 失败（现有三态语义天然支持）。
4. **安全默认**：SNMP community 可配置、超时短、walk 上限（现有 40 条已合理）；9100 通道默认关闭、需用户显式启用（避免与在用队列互扰）。

### 7.2 接口建议（TypeScript 形态，仅示意不落码）

```ts
interface VendorAdapter {
  id: string                       // 'brother-pjl' | 'hp-snmp-ext' | ...
  detect(ctx: VendorDetectContext): number   // 0..1 置信度
  enhance(ctx: PrinterContext): Promise<Partial<CapabilityReport> & { probes: CapabilityProbe[] }>
  // 禁止：submitJob / cancelJob / 覆盖 merge 后的 SUPPORTED 能力
}
```

### 7.3 分阶段路线

| 阶段 | 内容 | 性质 | 预期收益 |
|---|---|---|---|
| **P1（标准二级来源，零厂商知识）** | ✅ 已完成（v0.3.1）：① SNMP HOST-RESOURCES `hrPrinterDetectedErrorState`/`hrPrinterStatus`（walk hrDeviceType 定位 printer 设备 + 位掩码解析 → 缺纸/卡纸/门开/耗材告警，作为状态二级来源融合）② community 可配置（settings.snmpCommunity + PATCH /api/settings + 配对页 UI）③ IPP `toner-low/ink-low` 告警附加 ④ driverless 判定含 `image/urf`/`application/pdf` | 纯标准 | 耗材/状态覆盖显著提升，无维护负担 |
| **P2** | ✅ 已完成（v0.3.1）：ipps:// TLS——client 侧 node:https + rejectUnauthorized:false（TOFU 自签容忍，与 CUPS driverless 一致）；VIPP 提供 :3063 TLS 测试端点；自测场景 15 ipps-full-flow 验证全链路 | 纯标准 | 企业机与新款家用机安全合规 |
| **P3** | ✅ 已完成（v0.3.2）：eSCL 扫描——自研 eSCL 客户端（HTTP + XML，对齐 sane-airscan 生态：ScannerStatus / ScanJobs 创建 / NextDocument 逐页取图 / Delete 取销，https TOFU）+ mDNS `_uscan._tcp` 发现；Virtual eSCL Scanner 测试端点 **:3065**（vscan-flatbed / vscan-adf 两档案）；自测场景 16 escl-full-flow（Platen 单页 + Feeder 多页 + PNG 魔数/IHDR 断言 + 取销容错） | 事实标准 | AirPrint MFP 的扫描能力落地（PNG 多页输出；PDF 合成、双面扫描留后续） |
| **P4（首个真 Vendor Adapter）** | ✅ 已完成（v0.4.2）：PJL over RAW 9100 双向探测——自研 PJL 客户端（node:net 连接 → UEL `\x1b%-12345X` 包裹 `@PJL INFO STATUS / SUPPLY` 查询 → 宽容 key="value" 解析；CODE 子集映射 10001/10002/10004/40014/40017/40019，未知 CODE 返回 unknown 不猜测）；Virtual PJL Printer 测试端点 **:3067**（UEL 切段 + INFO STATUS/SUPPLY/CONFIG/PAGECOUNT 回读 + RAW 字节累计 + 9 状态注入）；`settings.pjlProbeEnabled` 默认关闭（本表 7.1 安全默认）+ `pjlPort`（真实设备 9100）；通道优先级由 merge 来源序天然保证（VENDOR_API < SNMP < IPP），状态融合仅当 SNMP 未应用时兜底；自测场景 20 pjl-vendor-probe（直连探测/RAW 字节/真实路由启停/paper-out 状态融合/toner-low 耗材联动不映射状态/关闭后探测消失/settings 还原）。**@PJL INFO SUPPLY 为 Brother 风格试点格式（公开资料未标准化），真实机型需抓包适配** | 厂商专用 | 消费级墨量长尾（Brother/HP 等 SNMP 缺失机型）；适配层模式已验证 |
| **P9（HP LEDM/CDM Vendor Adapter）** | ✅ 已完成（v0.4.7）：基于 P8 归档 HPLIP 3.26.4 源码实证通道的双通道只读 HTTP 探测——**LEDM :8080** XML 三文档（`/DevMgmt/ProductStatusDyn.xml` 状态 StatusCategory 官方枚举子集映射 / `ConsumableConfigDyn.xml` 耗材 ConsumableInfo 节点树逐色墨盒 / `MediaHandlingDyn.xml` 纸盒 InputTray/InputBin + Accessories autoDuplexor）+ **CDM :80** JSON（`/cdm/supply/v1/suppliesPublic` suppliesList）；命名空间剥除对齐 HPLIP 官方解析（psdyn:/ccdyn:/mhdyn:/dd: 等）；LEDM 优先 CDM 兜底；`settings.hpLedmProbeEnabled` 默认关闭 + hpLedmPort 8080 / hpCdmPort 80；状态融合链 IPP→SNMP→PJL→HP 逐层守卫；Virtual HP LEDM/CDM Printer 测试端点 **:3068**（四文档应答 + namespaced/bare/404 三风格宽容解析验证 + 8 状态注入）；自测场景 22 hp-ledm-vendor-probe（直连探测/命名空间剥除/真实路由启停/耗材四色墨+纸盒+双面融合/paper-out 状态融合/toner-low 耗材联动不映射状态/404→UNKNOWN 兜底红线回归/settings 还原）。**XML/JSON 响应格式对齐 HPLIP 解析路径；真实 HP 机型响应细节仍以实测为准（无真机不宣称）** | 厂商专用（源码实证级） | HP 消费级/商用机墨量+纸盒+双面+状态四类回读（LEDM 机型代际覆盖待真机统计） |
| **P5（可选）** | 厂商 MIB 解析包（HP/Lexmark/Kyocera 公开 MIB 文件加载私有 OID 映射）；EWS 抓取明确列为**反模式不建议** | 厂商专用 | 维修件计数等增强信息 |

---

## 8. 参考资料清单

**标准（PWG / IETF / OASIS）**
- RFC 8010 —— IPP/1.1: IPP/2.0 Encoding & Transport
- RFC 8011 —— IPP/1.1: IPP/2.0 Model & Semantics（`printer-state-reasons`、`marker-*` 属性族）
- RFC 3805 —— Printer MIB v2（`prtMarkerSupplies*` 1.3.6.1.2.1.43.11.1.1.x、`prtAlertTable`、`prtGeneral*`）
- RFC 2790 / HOST-RESOURCES-MIB（`hrPrinterDetectedErrorState` 1.3.6.1.2.1.25.3.5.1.2）
- RFC 6762 / RFC 6763 —— mDNS / DNS-SD
- PWG 5100.14-20xx —— IPP Everywhere（含自认证打印机注册库）
- PWG 5102.4 —— PWG Raster Format（image/pwg-raster）；Apple URF（image/urf）为 AirPrint 变体
- PWG IPP Scan（候选标准，部署稀少）；Apple Bonjour Printing Specification v1.2.1（`_universal._sub._ipp._tcp`、TXT 记录约定）
- OASIS WS-Discovery / WS-Print(v2) —— WSD 打印

**开源项目 / 数据库（公开可查证）**
- OpenPrinting CUPS（github.com/OpenPrinting/cups）及文档 `doc/network.html`（Bonjour 网络打印机）
- OpenPrinting 打印机兼容数据库（openprinting.github.io/database.html）；cups-filters
- ippeveprinter / **ippeveselfcert**（github.com/istopwg/ippeveselfcert，IPP Everywhere 自认证工具）与 ipptool/ippfind（CUPS 自带）
- **sane-airscan**（github.com/alexpevzner/sane-airscan，eSCL + WSD-Scan 双协议驱动扫描）
- epson-inkjet-printer-escpr（Epson ESC/P-R 官方开源 Linux 驱动）；brlaser/brgenml（Brother 开源驱动）
- Home Assistant Brother 集成（SNMP 43.11 OID 读墨量的生态实证）
- PWG IPP Everywhere 自认证打印机列表（pwg.org/printers）；Mopria 认证产品库（mopria.org/certified-products）
- Microsoft Universal Print 兼容机型列表（learn.microsoft.com）
- Debian Wiki「CUPSDriverlessPrinting」

**厂商公开文档（示例，均为公开入口）**
- HP Jetdirect TCP/UDP 端口表（support.hp.com c02480766）；HP/Canon/Epson/Brother/Lexmark/Kyocera 官网 MIB 下载与协议白皮书
- Epson Connect API 开发者门户（developer.epsonconnect.com，纯云端）
- Xerox 支持文档：AirPrint/Wi-Fi Direct 移动打印选项说明

> 以上厂商侧资料仅用于佐证通用结论；**任何具体型号的私有 OID 数值、私有端口细节均未在本文编造，以厂商 MIB 文件与实际抓包为准。**
