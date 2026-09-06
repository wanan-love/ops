# P3 eSCL 扫描后端（ops-host）— 工作记录

任务 ID：`p3-escl-scan-backend` · Agent：后端（Bun/TypeScript strict）
工作目录：`/home/z/my-project/mini-services/ops-host`
状态：**完成（16/16 自测通过）**

## 新增文件

| 文件 | 说明 |
| --- | --- |
| `src/backends/escl/client.ts` | eSCL 客户端（HTTP+XML，node:http/https，https TOFU 不校验证书）。`esclRequest()` 通用 GET/POST/DELETE；`getScannerStatus`（正则取 `<scan:State>`）、`createScanJob`（ScanSettings XML → 201 + Location 拼 origin）、`getNextDocument`（404/409 抛 `EsclHttpError(status)` 供上层语义分支）、`cancelScanJob`（幂等）。 |
| `src/vscan/server.ts` | Virtual eSCL Scanner（端口 3065，2 档案 vscan-flatbed / vscan-adf）。内存 Map 任务（readyAt=+1800ms 模拟扫描延迟）；路由 POST /eSCL/ScanJobs（正则解析 XML）、GET …/NextDocument（404 取完 / 409 未就绪 / 200 PNG）、GET /eSCL/ScannerStatus、DELETE。**PNG 纯手写**：node:zlib deflateSync + CRC32 查表法（0xEDB88320），IHDR/IDAT(每行 filter 0)/IEND；尺寸分档 150→425×550 / 300→850×1100 / ≥600→1700×2200；内容=白底+顶部 120px 渐变带（页1红黄/页2蓝绿，灰度按 0.299/0.587/0.114）+每 28px×3px 深灰文字行+左上 80×80 对齐块+右下 pageIndex 个 20×20 页码方块。start() 自检魔数+IHDR（日志 `[vscan] PNG 自检通过: 850x1100, 8431 bytes`）。 |
| `src/core/scan.ts` | ScanManager：设备（vscan 静态 + manual 持久化 scan-devices.json + mdnsScan 实时去重）；任务（startScan→createScanJob→后台循环 sleep600→NextDocument 409 重试/404 结束/30s 总超时→每页落盘 `scan-jobs/{id}/page-{n}.png`→completed 时 pagesTotal=pagesDone）；cancelJob（eSCL DELETE 幂等）、removeJob、getJobImageBytes；load() 重启恢复（进行中→failed "Host 重启导致扫描中断"）。 |
| `src/tests/scenarios-scan.ts` | 场景 16 `escl-full-flow`：设备列表 → Platen 300dpi 单页（PNG 魔数+IHDR 850×1100）→ ADF Feeder 2 页 Grayscale → 150dpi 取消。 |

## 修改文件

- `src/core/types.ts`：追加 `ScanDevice` / `ScanJobState` / `ScanJob` 分区；`HostInfo.vscanPort?: number | null`。
- `src/core/eventbus.ts`：`BusEvents` 加 `'scan:update': { job: ScanJob }`。
- `src/discovery/mdns.ts`：`QUERIED_SERVICES` 加 `_uscan._tcp.local`；`MdnsServiceOptions.vscan?`；serviceInstances/answerQuery/aggregate 全链路支持 _uscan；**aggregate(packets, mode)** 双模式（printers=过滤 _uscan 不进打印列表 / scanners=只留 _uscan，uri=`http://{ip}:{port}`，txt.service 固定）；新增 `scanUscan(windowMs=2000)`（独立查询+聚合，与 scan 共用 collectBuffer 互斥）。
- `src/http/routes.ts`：vipp 块后追加 9 条 `/api/scan/*` 路由（devices / scan-mdns / POST devices 探活 400 / DELETE 仅 manual / jobs 202+dpi∈[75,1200] 校验 / jobs 列表详情 / image 二进制 image/png+attachment / cancel / delete）。
- `src/ws/realtime.ts`：offs 加 `ctx.bus.on('scan:update', …)`。
- `src/host.ts`：`OPS_VSCAN_ENABLED`/`OPS_VSCAN_PORT`（默认 3065）；vscan 启动失败降级 null；`scan = new ScanManager({ storage, bus, log, scanUscan: () => mdns.scanUscan() })` + load()；HostContext 加 `vscan/scan`；mdns 构造传 vscan（**装配顺序：vscan 在 mdns 之前**）；dispose 加 vscan；hostInfo 加 vscanPort。
- `src/tests/selftest.ts`：RunManifest 加 `scanJobIds`；autoCleanup 走 `ctx.scan.removeJob`（内存+磁盘同步清）；ScenarioApi 加 7 个扫描方法（vscanAvailable/scanDevices/startScan/scanJob/waitForScan/cancelScan/scanArtifactBytes）。
- `src/tests/scenarios.ts`：ScenarioId 加 `'escl-full-flow'`；all 数组与 scenarioMeta 并入 scanScenarios。

## 开发中修掉的坑

1. **`this.bus` vs `this.opts.bus`**：ScanManager 构造注入 opts，startScan 里误写 `this.bus.emit` → 启动即报 undefined（冒烟首例 400 暴露），统一改 `this.opts.*`。
2. **mDNS answerQuery 缺 A 记录**：_uscan 响应只有 PTR/SRV/TXT → 聚合 ip 回退 127.0.0.1 → 与本机 vscan baseUrl 撞车被去重（scan-mdns 间歇性 0 台）。修复：answerQuery 响应附带本机 hostname A 记录。
3. **同端口多档案去重键**：vscan 两档案 uri 相同（http://ip:3065）→ aggregate 按 uri 去重只留 1 台；ScanManager.mdnsScan 也按 uri 去重吞掉第二台。修复：aggregate 去重键改 instanceName（扫描仪模式），mdnsScan 去重键改 `baseUrl|name`。
4. **autoCleanup 只删磁盘不删内存**：`ctx.storage.remove()` 删了目录但 ScanManager jobs Map 残留 → API 仍返回。修复：改调 `ctx.scan.removeJob()`。
5. 验证时注意：机器上同时存在 `bun --watch index.ts`（dev 残留）与 `bun index.ts` 两实例会互占端口（EADDRINUSE 3061/3063/3065）；先 `pgrep -af bun` 清干净再单实例启动。

## 验证结论

- 端口 3001/3002/3061/3063/3065 全 UP；host.log 无报错（PNG 自检 + vscan 监听日志齐全）。
- 冒烟：flatbed 300dpi→completed 1 页，PNG 8431 bytes 魔数/IHDR 850×1100/colorType 2 ✓；adf Feeder→completed 2 页（第 2 页 colorType 0 灰度）✓；manual 添加（探活 404→400 ✓）；scan-mdns 稳定发现 2 台（`_uscan._tcp.local`，ip 21.0.3.42）；cancel/delete/非 manual 删除 400/dpi 越界 400/设备 404 全对。
- 全量自测 **16/16**（两次），escl-full-flow 3949ms 18 步 pass；自测后 3 台种子打印机不变、scan-jobs 空目录零残留（autoCleanup 生效）；冒烟数据已清（devices 2 台 vscan、jobs 0）。

前端（`/home/z/my-project/src`）为另一任务，未触碰。
