# Epson 官方驱动逆向分析 — ESC/P-R 1.7.9（UOS/AMD64）

> 任务来源：用户指定驱动页
> `https://www.epson.com.cn/drive/43bdfda1a61947a081895d1bfe613e77.html?productId=96bf4b1d58cf4079a4a823b1740432ef`
> 逆向日期：2025-09-07（P6 厂商研究阶段）
> 证据文件：本目录 `epson-escpr_1.7.9_amd64.deb`（原包名 `signed_epson-inkjet-printer-escpr_1.7.9_amd64.deb`，219,438 字节）与 `Epson-L4350_Series-epson-escpr-en.ppd`（148,025 字节）
> 分析方法：`dpkg-deb -R` 解包 + PPD 关键字审计 + `nm -D`/`objdump`/`strings` 二进制符号逆向。**全部结论来自包内实际文件，无一推测。**

---

## 0. 包元数据（DEBIAN/control）

| 字段 | 值 |
|---|---|
| Package | `epson-inkjet-printer-escpr` |
| Version | `1.7.9` |
| Architecture | `amd64` |
| Maintainer | Seiko Epson Corporation \<linux-printer@epson.jp\> |
| Depends | `deepin-elf-verify, cups` |
| 适用型号（下载页） | Epson L4353 / L4358 / L4356 / L4359（页面标注，PPD 内含 48 个型号） |
| 平台 | UOS（统信，Linux/DEB 系） |

包内容物（全部）：
- `opt/Epson/epson-inkjet-printer-escpr/lib/cups/filter/epson-escpr`（ELF x86-64，CUPS 栅格过滤器，stripped）
- `opt/Epson/.../filter/epson-escpr-wrapper`（ELF x86-64，stripped）
- `usr/lib/libescpr.so.1.0.0` + `libescpr.a`/`libescpr.la`（**核心库：官方能力 API 所在**）
- `usr/share/cups/model/Epson/epson-inkjet-printer-escpr/*.ppd`（48 个型号 PPD）
- `DEBIAN/postinst`：仅 `ln -s` PPD 目录到 `/usr/share/ppd/` + `ldconfig`（**无守护进程、无服务、无墨量轮询**）

---

## 1. PPD 声明的官方能力（L4350 Series，覆盖 L4353/L4358/L4356/L4359）

PPD 头部身份：`*1284DeviceID: "MFG:Epson;MDL:L4350 Series;DES:EPSON L4350 Series;"`
（→ 厂商识别应走 IEEE 1284.4 Device ID 的 MFG/MDL，而非 IP 网段猜测——与本项目 `docs/VENDOR_PROTOCOLS.md` §厂商识别 的结论一致。）

### 1.1 全部 OpenUI 选项组（官方暴露给用户的**完整**能力面）

| UI 组 | 官方值 | 对应 OPS 能力轴 |
|---|---|---|
| `MediaType`（9 项） | PLAIN / LETTERHEAD / SFINE(Epson Photo Quality Ink Jet) / PMMATT(Epson Matte) / PLATINA(Epson Ultra Glossy) / PMPHOTO(Epson Premium Glossy) / PSGLOS(Epson Premium Semigloss) / LCPP(Photo Paper Glossy) / ENV(Envelope) | （OPS 未做介质类型轴） |
| `OutputMode`（2 项） | HIGH=**720×720dpi**（cupsCompression 3）/ NORMAL=**360×360dpi**（cupsCompression 2）。**无 DRAFT、无 1440** | `maxResolutionDpi` 上限 **720** |
| `ColorModel` | RGB（默认）/ Gray，8bit/色 | `color`（ColorDevice: True） |
| `Duplex` | **None / DuplexNoTumble（长边）/ DuplexTumble（短边）** → 该系列**官方声明支持自动双面** | `duplex` = `both`（官方证据） |
| `PageSize` | A4、A4.Fullbleed、4x6、4x6.Fullbleed、5x7、5x7.Fullbleed、A6、A5、B5(JIS)、B6(JIS)、3.5x5、3.5x5.Fullbleed + **CustomPageSize**（宽 144–612.2pt、高 243.6–3402pt） | `paperSizes`（12 种 + 无边距变体 + 自定义） |
| `Brightness` | −25…+25 | （OPS 未做渲染调节轴） |
| `Contrast` | −25…+25 | （OPS 未做渲染调节轴） |
| `Saturation` | −25…+25 | （OPS 未做渲染调节轴） |

### 1.2 PPD **未声明**的能力（官方驱动不暴露 → OPS 侧应保持 UNKNOWN，与现有行为一致）

| 能力 | PPD 证据 | OPS 现状 |
|---|---|---|
| 纸盒/进纸选择（InputSlot） | **L4350 PPD 无任何 `*InputSlot`**（单一进纸通道） | `paperTrays` UNKNOWN ✅ 正确 |
| 分辨率多档可选 | 无 `*Resolution` UI（档位硬编码于 OutputMode） | — |
| 出纸槽（OutputBin） | 无 | 未实现 ✅ |
| 可安装选件（InstallableOptions） | 无 | 未实现 ✅ |
| 墨量/耗材 | PPD 层无（见 §2 libescpr） | consumables 走 IPP/SNMP ✅ |
| 硬件边距（HWMargins） | 未声明（Fullbleed 页型即无边距打印声明） | — |
| 速度 ppm | `*Throughput: "1"`（占位值，无真实 ppm） | ppm 只能 IPP/SNMP ✅ |
| 自动切纸/装订/打孔 | 无 | 未实现 ✅ |

### 1.3 跨型号能力差异验证（PPD 逐型号声明 ≠ 品牌统一能力）

| 型号 PPD | InputSlot（纸盒） | Duplex | 佐证结论 |
|---|---|---|---|
| L4350 Series | ❌ 无 | ✅ 长边+短边 | 家用 EcoTank：自动双面、单进纸 |
| WF-6590 Series | ✅ Auto / RearPaperFeed / Cassette1（3 源） | ✅ | 商务机型才有纸盒轴 |
| M2120 Series | ❌ 无 | ❌ **无 Duplex UI**（仅单面） | 单面机型存在 → 不能按品牌推双面 |
| L3150 Series | ❌ 无 | ❌ 无 Duplex | 同上 |
| L805 Series | ❌ 无 | ❌ 无 Duplex | 照片机单面 |

**结论：duplex/paperTrays/纸型集合全部「逐型号」声明，任何按品牌推断都必然出错。本项目三态红线 + 逐设备探测的架构被官方驱动包直接验证。**

---

## 2. libescpr.so 官方 API 逆向（`nm -D` 全部导出符号）

### 2.1 能力/状态查询 API（最有价值）

| 导出符号 | 语义（据符号名+调用上下文） | 对 OPS 的意义 |
|---|---|---|
| `epsGetSupplyInfo` | 查询耗材/供应信息 | **官方 Linux 栈具备网络墨量查询 API** |
| `epsGetInkInfo` | 查询墨水信息 | 同上（更细粒度） |
| `epsGetStatus` | 查询打印机状态 | 官方状态通道 |
| `epsGetSupportedMedia` | 从打印机读取支持的介质表 | 官方介质能力下发 |
| `epsGetPrintableAreaInfo` / `…All` / `epsGetPrintableArea` / `epsGetUsersizeRange` | 可打印区域/自定义纸尺寸范围 | 官方几何能力下发 |
| `epsMakeMainteCmd` | 构造维护命令（喷头清洗 CLEAN 等） | 官方维护通道（OPS 未实现，列入候选） |
| `epsFindPrinter` / `epsCancelFindPrinter` / `epsProbePrinter` | 官方发现/探测 | 与 OPS mDNS+SNMP 发现正交 |

### 2.2 传输通道（strings + objdump 实证）

- **网络：`raw` 通道 + `snmp` 通道**
  - `rawGetDefautiPort` 反汇编 `mov $0x238c,%eax; ret` → **TCP 9100**（0x238C=9100，JetDirect RAW；该常量在 `.so` 中出现 3 处）
  - `snmpOpenSocket / snmpFind / snmpProbeByID / snmpCreatePDU / snmpMakeIntField / snmpMakeStrField / snmpParseField / snmpTransactS`，community 字符串 `public` → **SNMP 发现/探测走 UDP 161 标准 community 模式**
  - `@EJL 1284.4` 握手串 → 网络上的 IEEE 1284.4 设备 ID 询问（ESC/P-R 会话头）
- 本地：`usb*`（USB）、`lpr*`（并行口）、`ser*`（串口）、`cbt*`（通信抽象层）
- 渲染内核：`SetupJobAttrib / PrintBand / SendCommand / CompressBitImage / DeltaRow*`（栅格压缩为 Epson DeltaRow 变体）

### 2.3 关键限制（诚实声明）

1. `epsGetInkInfo`/`epsGetSupplyInfo` **无公开头文件、无公开规范**（包内只有 `.so`/`.a`，无 include），参数 ABI 需自行拟合；被 Epson 自家闭源工具（Windows Status Monitor / 打印机工具）同源调用。
2. 本 deb 的 CUPS 过滤器 `epson-escpr` 二进制中**未引用**任何 ink/supply 字符串 → 官方 Linux 打印链路本身不在打印时查墨量；这些 API 是留给外部工具的。
3. 网络墨量路径 = `epsGetSupplyInfo` 经 9100/ESC/P-R 私有双向会话 → **可行但属私有协议实现，且必须真机验证后才允许宣称**。

---

## 3. 对项目文档/代码的修正清单（本轮已执行）

| # | 位置 | 修正前 | 修正后 | 依据 |
|---|---|---|---|---|
| 1 | `VENDOR_PROTOCOLS.md` Epson 行 | 「SNMP…现代 Wi-Fi 机型常禁用/不完整」（无出处经验归纳） | 改为「真机未验证，以实际探测为准」+ 补 libescpr 官方通道证据 | 本文件 §2.2 |
| 2 | `VENDOR_PROTOCOLS.md` Epson 行 | 「开源驱动…即用它跑 9100」（惯例推断） | 升级为二进制实证（rawGetDefautiPort=0x238C） | 本文件 §2.2 |
| 3 | `VENDOR_RESEARCH.md` Epson 行 | 消费级墨量 ❌「暂不可做」（依据 Status Monitor 私有） | 证据升级为「中」：官方 Linux 库导出墨量 API（私有 ABI，需真机验证）→ 移入「可研究」候选，仍不做能力宣称 | 本文件 §2.1 |
| 4 | `ipp/capabilities.ts:81` | `attrResolution(...)?.x ?? 600`（解析失败猜 600 还标 supported） | 解析失败 → UNKNOWN 不猜测；集合取最大 dpi | 三态红线 |
| 5 | `printers-view.tsx` Chip | unknown 时展示钳制默认值（'双面（长/短边）'等）被误读为能力 | unknown 轴显示「XX：未确认」虚线 Chip + tooltip | 三态红线 |

## 4. 对 OPS 下一步的结论（研究 → 决策）

1. **不新增任何 Epson 能力宣称**：L4350 PPD 是「型号级官方证据」，仅当某台真实 L4350 系列被探测到时才有参考价值；通用路径仍走 IPP/SNMP 实时探测。
2. **Epson Vendor Adapter 候选（第二优先级，排在 HP-LASERJET-COMMON-MIB 之后）**：ESC/P-R `epsGetSupplyInfo` 风格状态通道（9100 + @EJL 1284.4 会话）。前提：真机抓包。**无真机不开发。**
3. **PPD 静态导入不做**：OPS 的能力来自运行时设备探测（IPP/SNMP/DC），导入 48 个 PPD 属于离线静态数据，违背「读不到 → UNKNOWN」红线且维护成本高。
4. 现有 `duplex/color/paperTrays` 逐设备三态架构与官方 PPD 逐型号声明的现实**完全吻合**，无需改动架构。
