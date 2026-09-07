# Epson 官方驱动逆向分析 — 201401w 1.0.0（低端 L 系列 / UOS/AMD64）

> 任务来源：用户指定驱动页（第二轮，低端机）
> `https://www.epson.com.cn/drive/aa32fa596a0e48d98c7f4cae6dc0b98d.html?productId=c46ab9c776104904a6c31a63c46cd921`
> 逆向日期：2025-09-07（P7 厂商研究阶段）
> 证据文件：本目录 `epson-inkjet-printer-201401w_1.0.0_amd64.deb`（1,684,020 字节，md5 `0a425bee34f1ac432f32d115f1815391`）与 `Epson-L360_Series-epson-inkjet-printer-201401w.ppd`（187,909 字节，md5 `8086b22d3c9d0a199a967dcc111421ef`）
> 分析方法：`dpkg-deb -R` 解包 + 12 个 PPD 全量交叉审计 + `nm -D`/`objdump -d`/`strings` 二进制符号逆向。**全部结论来自包内实际文件，无一推测。**
> 对照基线：同目录 `EPSON_ESCPR_ANALYSIS.md`（P6，新代 L4350 系 / escpr 1.7.9）

---

## 0. 包元数据（DEBIAN/control）

| 字段 | 值 |
|---|---|
| Package | `epson-inkjet-printer-201401w` |
| Version | `1.0.0` |
| Architecture | `amd64` |
| Maintainer | Seiko Epson Corporation \<linux-printer@epson.jp\> |
| Installed-Size | 4269 KB |
| 适用型号（下载页） | Epson L220 / L313 / L363 / L365 / L455 / L310 / L130 / L360 |
| PPD 内含型号 | **12 个**：L130 / L132 / L220 / L222 / L310 / L312 / L360 / L362 / L365 / L366 / L455 / L456（页面未列 L132/L222/L312/L362/L366/L456，PPD 实际覆盖） |
| 平台 | UOS 20 SP1 专业版（AMD CPU） |
| 发布时间 | 2020-09-17（下载页标注） |
| 许可证 | GPL-2.0（包内 COPYING/GPL 文档齐全；`*cupsFilter` 链无闭源守护进程） |

包内容物（全部）：
- `opt/Epson/epson-inkjet-printer-201401w/lib/cups/filter/epson_inkjet_printer_filter`（ELF x86-64，CUPS 栅格过滤器，stripped，**内嵌公钥证书 + SHA 校验资源文件签名**）
- `opt/Epson/epson-inkjet-printer-201401w/lib64/libEpson_201401w.so.1.0.0`（核心库，796 个导出符号）
- `opt/Epson/epson-inkjet-printer-201401w/resource/Epson_201401w.1.data`（签名资源：打印机指令序列数据，MSVC 资源格式）
- `usr/share/cups/model/Epson/epson-inkjet-printer-201401w/*.ppd`（12 个型号 PPD）
- `DEBIAN/postinst`：注册过滤器 + PPD（**无守护进程、无服务、无墨量轮询**——与 escpr 包一致）

---

## 1. PPD 声明的官方能力（12 个型号 **完全一致**）

PPD 头部身份（L360）：`*Product: "(EPSON L455_L456_L36x_L22x_L31x_L13x Series)"`、`*1284DeviceID` 同族。

### 1.1 跨型号能力矩阵（12/12 全量审计，非抽样）

| 机型 | Duplex | InputSlot | Borderless | MediaType 项数 | 720dpi | 备注 |
|---|---|---|---|---|---|---|
| L130 / L132 / L220 / L222 / L310 / L312 / L360 / L362 / L365 / L366 / L455 / L456 | **全部：无** | **全部：无** | **全部：有** | **全部：4** | **全部：2 档** | 12 个 PPD 能力面逐字节一致（diff 仅型号名） |

→ **官方证据第二次验证「能力逐型号（本例逐代际）声明」**：本代 12 型无一支持自动双面、无一有纸盒轴；而 P6 的新代 L4350 同为家用定位却有双面长短边。**按品牌推断能力必错，按代际推断同样必错，只有逐型号证据可靠。**

### 1.2 L360 PPD 完整能力面（OpenUI 全审计）

| UI 组 | 官方值 | 对应 OPS 能力轴 |
|---|---|---|
| `MediaType`（4 项） | PLAIN（360×360）/ EMATTE（720×720）/ EPREMGLOSS（720×720）/ ENVELOPE（360×360）——**分辨率绑定介质，无独立 Resolution UI** | `maxResolutionDpi` 上限 **720**（与 L4350 同上限，但新代是独立 OutputMode UI） |
| `ColorModel` | RGB（默认，ColorDevice: True） | `color` = supported |
| `PageSize`（16 项） | A4 / A5 / A6 / B5 / Letter / Legal / 4x6 / 5x7 / 3.5x5 / 5x8 / 8x10 / 102x181mm / Postcard / Env10 / EnvDL / EnvC6 | `paperSizes`（16 种，比新代 L4350 的 12 种更多照片尺寸；无 CustomPageSize——低端代不支持自定义纸张） |
| `Borderless` | Off / **On**（12 型全部支持无边距） | （IPP 侧以 media-supported 无边距媒体名体现，paperSizes 轴已覆盖） |
| `Brightness`/`Contrast`/`Saturation` | 各 −25…+25（51 档） | （OPS 未做渲染调节轴，同新代） |
| 驱动级打印特性 | Watermark（位置/密度/大小/彩色）/ PosterPrinting / ReduceEnlarge / OutputPaper / ScaleRatio / Rotate180 / MirrorImage / ColorMode(EpsonVivid…) / Gamma / CMY 单通道校正 | 驱动 UI 特性，非设备能力 |
| `cupsManualCopies` | True（份数由 CUPS 过滤链手动实现——硬件未必有拷贝加速） | `maxCopies` 只能信 IPP `copies-supported` |
| `*Throughput` | **1（占位值）** | ppm 只能 IPP/SNMP ✅ |

### 1.3 PPD **未声明**的能力（官方驱动不暴露 → OPS 侧应保持 UNKNOWN）

| 能力 | PPD 证据 | OPS 现状 |
|---|---|---|
| 自动双面 | **12 型 PPD 均无 `*Duplex` UI**（连 None 选项都没有——设备无此硬件） | `duplex` 走 IPP `sides-supported` ✅ |
| 纸盒/进纸选择 | 12 型均无 `*InputSlot` | `paperTrays` UNKNOWN ✅ |
| 出纸槽（OutputBin） | 无 | 未实现 ✅ |
| 可安装选件 | 无 | 未实现 ✅ |
| 墨量/耗材 | PPD 层无（见 §2：**本代连库层私有 API 都没有**） | consumables 走 IPP/SNMP，读不到→UNKNOWN ✅ |

---

## 2. libEpson_201401w.so 逆向（与 P6 libescpr 的**代际断崖**）

### 2.1 状态/墨量 API：**不存在**

`nm -D` 全部 796 个导出符号中（前缀 EPC_/JFK_/ICM_/RBM_/Epht_/Halftone 等）：
- **无任何 `epsGetSupplyInfo` / `epsGetInkInfo` / `epsGetStatus` / `epsMakeMainteCmd` / `epsFindPrinter`**（新代 libescpr 全有，见 EPSON_ESCPR_ANALYSIS.md §2.1）
- 符号全部属于**打印管线**：半色调（`JFKDoHalftone`/`EphtInit`）、颜色转换（`jfk_rgb2_cmyk_*`）、波段输出（`BandOut`）、**ESC/P 指令构造**（`EPC_SendInitializeCommand`/`EPC_SendRasterImage_*`/`EPC_SendVPos`…）
- `JFK*Ink*` 系列是**打印侧墨水消费计算**（供半色调用），**不是设备墨量查询**

### 2.2 网络栈：**不存在**

- `nm -D` 导入符号（`U `）中**没有任何 socket/connect/bind/send/recv/httons**——库只能 `fopen`/`open` 本地文件
- 新代 libescpr 实证的 TCP 9100（`rawGetDefautiPort`=0x238C）+ SNMP 161 + `epsFindPrinter` 发现，在本代**全部缺失**
- `@EJL`/`@EJL 1284.4` 字符串存在，但仅作为打印会话握手指令输出给 CUPS 后端（USB/socket 后端由 CUPS 自身处理）
- 早期疑似 0x238C=9100 的 objdump 命中经核验为**函数地址/分支偏移假阳性**（如 `0x238c0 <RscLinkResult::GetCurType>`），非端口常量

### 2.3 安全机制（本代新增，新代未见）

过滤器内嵌 `-----BEGIN CERTIFICATE-----` 公钥与 base64 签名数据（`epcgWatermarkData`），对 `resource/Epson_201401w.1.data` 做签名校验——指令序列资源被官方签名保护，**第三方无法伪造/替换指令数据包**。

### 2.4 代际对比总表（两次官方逆向的合并结论）

| 维度 | 新代 escpr 1.7.9（L4350 系，2016+ 家用） | **老代 201401w（L130…L456，2014–2015 低端）** |
|---|---|---|
| 设备状态/墨量私有 API | ✅ `epsGetSupplyInfo` 等 5+ | ❌ **零** |
| 内置网络栈（9100/SNMP/@EJL 发现） | ✅ | ❌ **零 socket 导入** |
| 维护命令 API（清洗喷头等） | ✅ `epsMakeMainteCmd` | ❌ |
| PPD MediaType | 9 项 | 4 项 |
| PPD 分辨率呈现 | 独立 OutputMode UI（720/360） | 嵌入 MediaType 的 HWResolution |
| 自动双面 | L4350 有（长短边）；M2120/L3150/L805 无 | **12 型全无** |
| PageSize | 12 + Fullbleed 变体 + 自定义 | 16（无自定义纸张） |
| 资源签名校验 | 未见 | ✅ 内嵌证书 + SHA |
| 输出 | → 走 CUPS 后端（USB/socket/ipp） | 同 |

---

## 3. 对项目文档/代码的修正清单（本轮已执行）

1. `docs/VENDOR_PROTOCOLS.md` Epson 行：补充**代际拆分**证据——老代官方驱动「无状态 API、无网络栈」，libescpr 通道**只覆盖新代机型**，按品牌/系列一概而论必错。
2. `docs/VENDOR_RESEARCH.md` Epson 行 + §5：适配器候选范围收窄（「libescpr 适配器」→「libescpr 适配器（仅新代机型）」）；老代 L 系列耗材在 Linux 侧**官方自身就不提供任何读取通道** → IPP/SNMP 实测读不到即为终态 UNKNOWN，**这不是缺陷而是官方能力边界**。
3. 代码层复核：`src/backends/ipp/capabilities.ts` 三态语义与新证据零冲突（`sides-supported`/`marker-levels` 缺失→UNKNOWN 正确覆盖老代真实行为）；12 型无 InputSlot → `paperTrays` UNKNOWN 语义不变；**无需代码改动**。
4. `docs/VENDOR_RESEARCH.md` 证据来源区新增 P7 逆向条目。

## 4. 对 OPS 下一步的结论（研究 → 决策）

- **不新增任何能力宣称**：老代证据反向强化三态红线——官方都没有的能力，第三方更不可能凭空变出。
- **Vendor Adapter 优先级不变**：libescpr 私有墨量通道（需真机抓包）仍为第二优先级候选，但**作用域限定新代机型**；老代 L 系列（L130/L220/L310/L360/L365/L455 等）耗材只有 IPP `marker-*` + SNMP 两条标准通道，读不到即 UNKNOWN 终态。
- **双数据点定论**：「能力逐型号声明」由 L4350（同代跨型号差异：M2120 无双面 vs L4350 有）+ 本轮（跨代际断崖：同 L 系列低端代 12 型全无双面/无状态 API）**两次官方证据正交验证**——项目三态架构与按机型实测能力是唯一正确姿势。
- 潜在后续（未排期，仅记录）：若未来做「厂商研究 → 设备代际识别」，可利用 IPP `printer-make-and-model` + 1284DeviceID MDL 串匹配本报告 §1.1 矩阵提供离线能力参考（**但上线前必须仍以实时探测为准**）。
