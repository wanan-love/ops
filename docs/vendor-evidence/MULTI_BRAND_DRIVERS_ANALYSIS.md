# 多品牌官方 Linux 驱动逆向分析 — Brother / HP / Canon / Lexmark（P8）

> 任务来源：用户指令「用同样的方法 自行搜索品牌打印机的代表性机型及其对应的驱动，逆向分析，再对照其修改本项目」（P6/P7 Epson 双轮之后第三轮推广）
> 逆向日期：2025-09-07（P8 厂商研究阶段）
> 方法：web-search 检索官方驱动页 → curl 下载官方包 → `dpkg-deb -R`/`tar x` 解包 → PPD 全量审计 + `strings`/`nm -D`/`objdump -d` 二进制逆向。**全部结论来自包内实际文件，无一推测。**
> Kyocera 诚实记录：官方下载中心纯 JS 渲染（assets.adobedtm/launch），无直链可循，本轮未获取其官方驱动，证据级维持现状。

---

## 1. Brother HL-L2350DW（消费级单色激光，官方 deb）

### 1.1 获取链路（可复现）
- support.brother.com 下载列表页（os=128 Linux）→ downloadend.aspx（EULA）→ downloadhowto.aspx 泄出直链 → `download.brother.com/welcome/{dlid}/{file}`
- 归档文件：`brother-hll2350dwpdrv-4.0.0-1.i386.deb`（123,052B）+ PPD + `brHLL2350DWfunc` + `brother-linux-brprinter-installer-2.2.6.sh`

### 1.2 PPD 声明能力（brother-HLL2350DW-cups-en.ppd）

| 能力 | 官方值 | 对 OPS 能力轴 |
|---|---|---|
| `InputSlot` | **Manual + Tray1**（PPD 逐型号声明） | `paperTrays` = 2 源（真实轴） |
| `Duplex` | **None / DuplexNoTumble / DuplexTumble**（自动双面） | `duplex` = long+short |
| `Resolution` | 300 / 600 / **1200** / 2400x600（HQ1200）共 4 档独立 UI | `maxResolutionDpi` = **1200** |
| `ColorDevice` | False | `color` = false |
| `Throughput` | **"18"**（真实 ppm 声明——与 Epson/Canon 的占位 "1" 形成对照） | ppm 候补真实源 |
| 专有 UI | BrMediaType（4 项）/ TonerSaveMode / Sleep | 驱动级 |
| cupsFilter | `application/vnd.cups-postscript 0 brother_lpdwrapper_HLL2350DW`（**PostScript → PJL/PCL 转换在驱动内**） | — |

### 1.3 厂商能力声明文件（brHLL2350DWfunc，inf/）
`[SelectionItem]`：Paper Source={Manual,Tray1,**Tray2,Tray3,MpTray,AutoSelect**}（通用集，型号实际暴露以 PPD 为准）、Duplex={OFF,ON}+Type={Long,Short}、Resolution={300,600,1200,HQ1200A,HQ1200B}、**Copies={"1-999"}**、Sleep={"1-99"}、TonerSaveMode={ON,OFF}、Media 11 类、Paper Type 36 项。

### 1.4 二进制逆向（lpd/x86_64）

- **rawtobr3 输出完整 PJL 流**：`%-12345X@PJL`（UEL）+ `@PJL JOB/EOJ NAME="Linux print job"` + `@PJL SET ORIENTATION/MEDIATYPE/RESOLUTION/OUTBIN=OPTIONALOUTPUTBIN1..4` —— **Brother 官方 Linux 驱动以 PJL 作为作业控制语言，本仓 P4 的 PJL over RAW 通道被官方正面验证**（OUTBIN 四出纸槽支持随硬件可选）。
- brprintconflsr3：配置→ PJL/PCL 转换（TonerSave 转换函数），无网络代码。
- **驱动自身零 socket 导入**——传输全部委托 CUPS 后端。

### 1.5 官方安装器网络路径（linux-brprinter-installer-2.2.6.sh，行 2954）
```
"$LPADMIN" -p "$PRINTERNAME" -v lpd://"$ipadrs"/BINARY_P1 -E
```
→ **官方 Linux 安装器网络打印默认 `lpd://IP/BINARY_P1`（TCP 515，LPD BINARY_P1 队列）**，非 9100；USB 走 `usb://`（优先）或 `usb://dev/usblp0` 兜底。9100 为设备侧通用支持（其它工具/标准可行），但**「Brother Linux 官方默认 9100」的口径不成立，须修正**。

---

## 2. HP（HPLIP 3.26.4 官方开源全栈，源码级实证）

### 2.1 获取链路
- SourceForge CDN 403（反爬）→ Debian 官方归档 `deb.debian.org/debian/pool/main/h/hplip/hplip_3.26.4+dfsg0.orig.tar.xz`（9.4MB，**上游同一 HP 源码的 dfsg 重打包**，与 sourceforge hplip 3.26.4 同版本）
- 归档文件：`hplip-code/{pml.py, jd.c, status.py, device.py}` + `hp-postscript-laserjet-pro.ppd`（HPLIP 源码 2,847 文件中与本仓结论直接相关者）

### 2.2 网络端口表（io/hpmud/jd.c 行 58-64，HP 官方 C 代码）

```c
static const int PrintPort[]  = { 0, 9100, 9100, 9101, 9102 };   /* JetDirect 3 通道 */
static const int ScanPort0[]  = { 0, 9290, 9290, 9291, 9292 };
static const int GenericPort[]= { 0, 9220, 9220, 9221, 9222 };
static const int ScanPort1[]  = { 0, 8290, 8290, 0, 0 };         /* CLJ28xx hack */
const char *kStatusOID = "1.3.6.1.4.1.11.2.3.9.1.1.7.0";         /* device id snmp oid */
```

→ **JetDirect 9100/9101/9102 三通道文档获官方源码正解**；另实证 HP 扫描通道 9290 系、通用通道 9220 系、CLJ28xx 专用 8290 hack。

### 2.3 设备发现/Device ID（jd.c device_id()）

- **网络打印机 IEEE 1284 Device ID 经 SNMP GET 读取**：`1.3.6.1.4.1.11.2.3.9.1.1.7.0`（HP 私有 OID，注释 "network/SNMP only (undocumented)"）；
- 失败后用**旧机默认 community `public.1` 重试**（jd.c 行 93 注释：old HP printers）→ 与本项目 SNMP 通道「community 可配置」的必要性互证。

### 2.4 耗材/状态通道全栈（base/pml.py + base/device.py + base/status.py）

1. **PML→SNMP OID 映射**（pml.py 行 301-321）：`StdToSNMP: 2.x → 1.3.6.1.2.1.43.x`；`HPToSNMP: 1.x → 1.3.6.1.4.1.11.2.3.9.4.2`（HP 私有 MIB 树）。
2. **RFC 3805 marker supplies 正消费**（pml.py 行 414-422）：`OID_MARKER_SUPPLIES_TYPE_x = '2.11.1.1.5.1.%d'` → `1.3.6.1.2.1.43.11.1.1.5.1.x`，枚举 toner=3 / waste-toner=4 / ink=5 / ink-cartridge=6 / ribbon=7 ——**与 RFC 3805 prtMarkerSuppliesType 完全一致，HP 官方代码走标准 MIB 读耗材**。
3. **LEDM（Low End Data Model）HTTP XML**（status.py）：`/DevMgmt/ProductStatusDyn.xml`（状态）+ `/DevMgmt/ConsumableConfigDyn.xml`（耗材）+ `/DevMgmt/MediaHandlingDyn.xml`（纸张）。
4. **CDM HTTP JSON**（device.py 行 1705 / status.py 行 2296）：`http://{host}/cdm/supply/v1/suppliesPublic`（忽略自签证书 `ssl._create_unverified_context`）。
5. **状态通道类型枚举 13 种**（STATUS_TYPE_*）：包含 IPP（cupsext.getStatusAttributes）、CDM_USB/CDM_Net、LEDM 系列……官方按机型适配动态选择。

### 2.5 对 OPS 的结论
- 「HP Smart 云端无公开局域网墨量 API」维持，但**修正补充：官方 HPLIP 证明部分机型局域网存在 LEDM（/DevMgmt/*.xml）与 CDM（/cdm/supply/v1/suppliesPublic）HTTP 端点**——这是 SNMP 缺失的消费喷墨机潜在通道，列为 Vendor Adapter 新候选（证据级：官方源码，但响应格式需真机验证）。
- 通用 PS LaserJet Pro PPD（hp-postscript-laserjet-pro.ppd）：Duplex 三值 + **InputSlot Auto/Tray1/Tray2/Tray3/Tray4**（PostScript setpagedevice）——企业级纸盒轴官方声明。

---

## 3. Canon PIXMA（cnijfilter2 6.90 官方 deb，消费喷墨全家族）

### 3.1 获取链路
- asia.canon 支持页 0101281701（IJ Printer Driver Ver.6.90 for Linux debian）→ `pdisp01.c-wss.com/gdl/WWUFORedirectTarget.do?id=…` 302 → `gdlp01.c-wss.com/gds/7/0100012817/01/cnijfilter2-6.90-1-deb.tar.gz`（1.4MB）
- 归档文件：`canon-cnijfilter2-6.90-1-deb.tar.gz` + `canonmg7700.ppd`（包内共 **179 个 PPD**：E/E300/G/MG/TR/TS 系列）

### 3.2 PPD 跨型号审计（6 代表机型 + 全量口径）

| 轴 | 官方值（MG7700 实测，其余 5 机型一致） |
|---|---|
| `Duplex` | **三值全有**（None/NoTumble/Tumble）——PIXMA 家用普遍自动双面 |
| `InputSlot` | **全部无**（单进纸） |
| `Resolution` | **600dpi 单档声明**（无多档 UI） |
| `PageSize` | 19 项含 **.bl 无边距变体**（A4.bl/4x6.bl/5x7in.bl/8x10.bl/Letter.bl…） |
| `MediaType` | 13 项 |
| `Throughput` | **"1"（占位值）** |
| cupsFilter | `rastertocanonij`（CUPS Raster→Canon IJ）+ `cmdtocanonij2`（CUPS-COMMAND→维护命令） |

### 3.3 网络栈逆向（关键：libcnbpnet30.so + libcnnet2.so + cnijbe2 backend）

- **`Cnmpu2_port9100` C++ 类**（符号表实证：setUrl/Read/Send/setTimeout/setMasterPortOption）——**Canon 官方网络打印库存在 9100 专用通道类**；
- **`Cnmpu2_http` 类 + HTTP 路径常量**：`/canon/ij/command1/port1..2`、`/canon/ij/command2/port1..5`——**Canon 打印机本机 HTTP 命令端口族**（状态/维护）；
- **BJNP UDP 8611**：libcnnet2 反汇编立即数 `$0x21a3`（=8611）×多处——**Canon 私有发现/状态协议 BJNP 的 UDP 端口官方实证**（此前文档「口径不一需抓包」→ 现为官方代码直接证据）；
- cnijbe2（CUPS backend）：USB（libusb）+ 网络（libcnnet2/libcnbpnet30/libcnbpcnclapicom2），状态回读调 `cnijlgmon3`。

### 3.4 状态协议逆向（libcnbpcnclapicom2.so —— CNCL API）

官方状态查询为 **ivec XML**（命名空间 `http://www.canon.com/ns/cmd/2008/07/common/`）：

```xml
<cmd xmlns:ivec="…"><ivec:contents>
  <ivec:operation>GetStatus</ivec:operation>
  <ivec:param_set servicetype="device|maintenance|print">
    [<ivec:jobID>00000001</ivec:jobID>]
  </ivec:param_set>
</ivec:contents></cmd>
```

维护命令同族：`<ivec:operation>Cleaning</ivec:operation><ivec:inkgroup>all</ivec:inkgroup><ivec:type>regular</ivec:type>`。
配套 API：`CNCL_GetStatus/GetStatus2/GetStatus_Maintenance`、`CLSS_ParseStatusResponse*`（状态/耗材解析）、`CLSS_IsSupportBJNP_From14Autumn`（2014 秋季机型起支持标志）。
打印数据格式双路：`tocanonij`（经典）与 `tocnpwg`（**PWG Raster**，`PwgRaster` 字符串 + cupsRaster* 调用）——现代 Canon 喷墨官方驱动即发 PWG Raster。

### 3.5 对 OPS 的结论
- 「PIXMA 走 Canon IJ（打印 TCP 9100）」**获官方代码正面实证**（Cnmpu2_port9100）；BJNP UDP 8611 同级实证；
- **新发现**：Canon 本机 HTTP 命令端口族 `/canon/ij/command{1,2}/portN` + ivec XML GetStatus/Cleaning——Canon Status Monitor 协议的具体形态（结构公开于二进制内，但 schema 无公开文档，需真机验证响应）→ 列为 Vendor Adapter 候选（证据级：官方二进制字符串+反汇编）。

---

## 4. Lexmark（inkjet-08 老代消费驱动，2009，NPA 私有协议实证）

### 4.1 获取链路
- support.lexmark.com DR860 页 → `downloads.lexmark.com/downloads/cpd/lexmark-inkjet-08-driver-1.0-1.i386.deb.sh.zip`（31MB）→ nixstaller 自解压 --noexec → LZMA 内层 tar → deb → `usr/local/lexmark/lxk08/`
- 归档文件：`lexmark-lx2600.ppd`（内层 deb 30MB 不入仓，报告记录结构与关键 .so 结论）

### 4.2 逆向结论
- lx2600.ppd：无 Duplex、无 InputSlot、Throughput="15"、`cupsFilter → /usr/local/lexmark/lxk08/bin/printdriver`（**host-based 专有渲染器**，非标准 PDL）——消费 Lexmark = GDI 类路线（与 Canon CAPT 同类，验证 VENDOR_PROTOCOLS「host-based 家族」论断）；
- **NPA 协议实证**（libhdctransport.so + libnpa407.so）：C++ 类 `NpaProtocol`/`NpaWrapV3Protocol`/`NPA407Comm`（COMM_StartJob/StartPage/GetRawData…），走 `USBLP_PORT` —— **Lexmark 私有双向 NPA（Network Printing Alliance）协议**做状态/命令通道（USB 消费机）；
- 打包年代 2009-05（jre1.6 内嵌），仅作历史证据：**Lexmark 消费线私有通道 = NPA over USB LP；企业线公开 MIB 路线不受影响**（本轮未取企业驱动，下载页 JS 化，诚实记录）。

---

## 5. 跨品牌合并对照（五包官方证据的合并结论）

| 维度 | Brother | HP | Canon | Epson（P6/P7） | Lexmark |
|---|---|---|---|---|---|
| 官方 Linux 打印传输 | **LPD BINARY_P1（安装器默认）/ CUPS 后端** | **9100/9101/9102**（hpmud） | **9100（Cnmpu2_port9100）** | 9100（libescpr，仅新代） | host-based（专有渲染） |
| 官方状态/耗材通道 | PPD 驱动层无（依赖设备标准通道） | **PML→SNMP RFC 3805 + HP OID 11.2.3.9.4.2 + LEDM HTTP XML + CDM HTTP JSON + IPP**（13 类 StatusType） | **CNCL ivec XML over BJNP/HTTP /canon/ij/command2/portN** | 新代 epsGet*（无 ABI）；老代零 | **NPA over USB LP** |
| 发现 | CUPS usb://（安装器） | SNMP Device-ID OID + mDNS/DNS-SD | **BJNP UDP 8611** | 新代 SNMP+9100 探测 | lsusbdevice 工具 |
| PPD 双面 | HL-L2350DW 三值 | PS 通用 PPD 三值 | PIXMA 全家族三值 | 逐型号（L4350 有/老代 L 系全无） | lx2600 无 |
| PPD InputSlot | Manual+Tray1 | Auto+Tray1-4 | 全家族无 | 逐型号 | lx2600 无 |
| Throughput 真实性 | **18（真实）** | — | 1（占位） | 1（占位） | 15（真实） |
| 维护命令 | PJL（UEL 包裹） | PML OID（OID_CLEAN 等） | ivec XML Cleaning | epsMakeMainteCmd（新代） | NPA COMM_* |

**总结论（对项目文档与架构的修正/强化）**：
1. 「9100 是事实通用打印端口」**跨厂商再验证**：HP（源码）/Canon（类名）官方依赖，Brother 设备侧支持但 Linux 安装器默认 LPD —— **按厂商/机型声明传输，而非一刀切**；
2. **状态通道多样性**：HP 五通道并存（SNMP/PML/LEDM/CDM/IPP）、Canon ivec XML over HTTP、Epson 代际断崖、Lexmark NPA —— 「三态 + 实测探测」是唯一能覆盖这种多样性的架构（项目既有路线再获验证）；
3. **新增三个 Vendor Adapter 候选**（全部有官方代码级证据，但均需真机验证响应格式）：HP LEDM/CDM HTTP（SNMP 缺失的消费喷墨）、Canon ivec XML（PIXMA 状态）、Brother PJL SET OUTBIN（出纸槽，P4 已有 PJL 基础）；
4. PJL/UEL 为 Brother/HP 共同基础语言 —— P4 PJL 通道的战略价值官方背书；
5. **Throughput 真实性逐厂商**：Brother/Lexmark 真实声明，Epson/Canon 占位 "1" —— PPD 是 ppm 的可靠来源仅限部分厂商，维持「ppm 只信 IPP/SNMP 实测」。
