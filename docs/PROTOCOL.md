# OPS/1.0 协议规范

Host 与 Client 之间的通信协议。REST（JSON）用于命令与查询，WebSocket 用于实时推送。

- REST：`http://{host}:{restPort}/api/*`（默认 3001）
- Realtime：socket.io，`path: '/'`（默认端口 = REST + 1，即 3002）
- 网关环境：`?XTransformPort={port}` 查询参数选择端口（见 deploy/Caddyfile.example）

## 通用约定

- JSON 响应：`{ "error": "..." }` 表示失败（4xx/5xx）
- 设备身份 header（打印相关请求建议携带）：
  - `X-OPS-Device`：deviceId（URL 编码）
  - `X-OPS-Device-Name`：设备名（URL 编码）
  - `X-OPS-Platform`：`windows|macos|linux|android|ios|web`
  - `X-OPS-Token`：配对令牌（pairing 安全模式必须）
  - `X-OPS-Options`：URL 编码的 JSON（打印选项）
  - `X-OPS-Admin`：`1` 表示 Host 控制台操作（允许打印到未共享打印机）

## REST 端点

### 系统 / 发现

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` / `/healthz` | 健康检查 |
| GET | `/api/system/info` | HostInfo（hostId/名称/版本/平台/安全模式/端口/数据目录） |
| GET | `/api/system/stats` | 任务统计、存储统计、后端可用性 |
| GET | `/api/discovery/hosts` | 当前可见 Host 列表（触发一次 UDP 公告） |
| GET | `/api/discovery/announce` | 手动触发公告 |

### 打印机

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/printers?scope=client\|admin` | client=仅共享；admin=全部（含 activeJobId） |
| GET | `/api/printers/{id}` | 单台详情 |
| POST | `/api/printers` | 创建虚拟打印机 `{name, description?, location?, shared?, capabilities?}` |
| PATCH | `/api/printers/{id}` | `{name?, description?, location?, shared?}`（shared 即共享/取消共享） |
| DELETE | `/api/printers/{id}` | 删除虚拟打印机（连带任务工件） |
| POST | `/api/printers/{id}/test-print` | 提交测试页（admin） |

### 打印任务

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/jobs?printerId=&fileName=` | **提交打印**。请求体 = 原始 PDF 二进制（≤20MB，`%PDF-` 魔数校验）；选项经 `X-OPS-Options`。返回 `{job}` |
| GET | `/api/jobs?printerId=&state=&deviceId=&limit=` | 任务列表 |
| GET | `/api/jobs/{id}` | 任务详情（全量时间线） |
| POST | `/api/jobs/{id}/cancel` | 取消（pending/processing/paused） |
| POST | `/api/jobs/{id}/retry` | 重试（failed/cancelled → 重新排队） |
| GET | `/api/jobs/{id}/events` | 时间线 |
| GET | `/api/jobs/{id}/document` | 下载原始 PDF |
| GET | `/api/jobs/{id}/result` | 模拟打印结果（result.json） |

### 配对 / 安全

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/pairing/requests` | 设备发起配对 `{deviceId, deviceName, platform}` |
| GET | `/api/pairing/requests` | 待审批列表（Host 控制台） |
| POST | `/api/pairing/requests/{id}/approve` | 批准 → 返回 `{token}` |
| POST | `/api/pairing/requests/{id}/reject` | 拒绝 |
| GET | `/api/pairing/status?deviceId=` | 设备侧轮询（批准后领取令牌） |
| GET | `/api/devices` / DELETE `/api/devices/{deviceId}` | 已配对设备管理 |
| GET/PATCH | `/api/settings` | `{hostName?, securityMode?, snmpCommunity?, pjlProbeEnabled?, pjlPort?}`（PJL 探测默认关闭，端口真实设备 9100） |

### Mock / 调试（Virtual Printer 注入点）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/mock/printers/{id}/condition` | `{condition: online\|offline\|paper-out\|paper-jam\|error, message?}` |
| POST | `/api/mock/printers/{id}/fix` | `{action: add-paper\|clear-jam}`（修复硬件，任务等待 Resume） |
| POST | `/api/mock/printers/{id}/resume` | 恢复暂停任务 |
| POST | `/api/mock/printers/{id}/speed` | `{ppm: 1–600}` 模拟打印速度 |
| POST | `/api/mock/printers/{id}/ink` | 加墨（CMYK → 100%） |
| POST | `/api/mock/printers/{id}/reset` | 重置（清条件/取消任务/满墨） |
| POST | `/api/mock/jobs/{id}/fail` | 指定任务失败（Fail Current Job） |
| GET | `/api/debug/sample-pdf?pages=2` | 生成示例 PDF |
| POST | `/api/debug/restart` | 模拟 Host 重启（磁盘恢复） |
| POST | `/api/storage/clear-test-data` | 清理 TEST 打印机/任务/测试报告 |

### Virtual PJL Printer（P4 · RAW 9100 仿真调试）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/vpjl/state` | 设备快照 `{condition, rawReceivedBytes, rawPageCount, connectionCount, updatedAt}` |
| POST | `/api/vpjl/condition` | `{condition: ready\|busy\|warmup\|offline\|paper-out\|paper-jam\|door-open\|toner-low\|toner-empty}`（注入 @PJL INFO STATUS 的 CODE / SUPPLY 的碳粉联动） |

### 事件 / 自动化测试

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/events?limit=&type=` | 事件日志（倒序） |
| GET | `/api/tests/scenarios` | 场景元数据 |
| POST | `/api/tests/run` | 启动（`{ids?}`，默认全部）→ `{runId}`（409 若已有运行） |
| GET | `/api/tests/runs` / `/api/tests/runs/{id}` | 测试报告（运行中也落盘） |

## WebSocket 事件（服务端 → 客户端）

| 事件 | 载荷 | 触发 |
|---|---|---|
| `welcome` | HostInfo + wsSocketId | 连接建立 |
| `job:update` | PrintJob（完整对象） | 状态变化/进度 tick(250ms)/里程碑 |
| `printer:update` | Printer | 状态/墨量/共享/统计变化 |
| `event` | OpsEvent | 任何领域事件 |
| `host:update` | HostInfo | 设置变更 |
| `pairing:update` | `{requests, devices}` | 配对变化 |
| `test:progress` | TestRun | 每个场景完成/失败 |
| `discovery:update` | `{hosts}` | 公告刷新 |
| `snapshot` | `{}` | 请求客户端重新拉取快照（Host 重启等） |

客户端 → 服务端：`hello`（回声测试，带 ack）。

## 示例：提交打印（curl）

```bash
curl -X POST "http://host:3001/api/jobs?printerId=vp-color-laser&fileName=doc.pdf" \
  -H "content-type: application/pdf" \
  -H "X-OPS-Device: my-device-001" \
  -H "X-OPS-Device-Name: My%20Laptop" \
  -H "X-OPS-Platform: linux" \
  -H "X-OPS-Options: %7B%22colorMode%22%3A%22color%22%2C%22copies%22%3A2%2C%22duplex%22%3A%22long-edge%22%7D" \
  --data-binary @doc.pdf
```

## 安全模型

- **open（MVP 默认）**：局域网信任，任何设备可打印（便于演示）
- **pairing**：提交打印必须携带有效 `X-OPS-Token`；令牌由 Host 控制台审批后经 `/api/pairing/status` 定向发放给请求设备
- 生产建议：反向代理 TLS、Host 控制台路由仅限本机访问、设备配额与审计（events.jsonl 已具备审计基础）
