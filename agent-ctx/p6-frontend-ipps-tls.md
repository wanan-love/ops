# P6 · ipps:// TLS 前端适配 + 文档更新（前端侧）

> Task: 前端适配后端已完成的 ipps TLS 支持（VIPP :3061 明文 + :3063 TLS，API 返回 tlsPort 字段）
> 日期：2026-09-06 · 执行角色：前端开发者 · 工作目录：/home/z/my-project

## 修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/lib/ops/types.ts` | `HostInfo` 接口在 `dataDir` 后新增 `vippTlsPort?: number \| null`（与后端 /api/system/info 返回的 vippTlsPort:3063 对齐） |
| `src/lib/ops/client.ts` | `VippInfo` 接口新增 `tlsPort: number \| null`（GET /api/vipp/printers 响应字段） |
| `src/components/ops/backends-view.tsx` | ① Virtual IPP 打印机行：URI 双行展示（ipps 第二行 + Lock 图标 + truncate），Profile 徽章旁加 `ipps` outline 徽章（tlsPort != null 时）② 面板标题新增 `TLS :{vipp.tlsPort}` secondary 徽章 ③「手动添加 IPP URI」：Label 改为「IPP URI（ipp:// 或 ipps://）」（原「暂不支持 TLS 会明确报错」文案已过时）、placeholder 改 `ipp://192.168.1.50/ipp/print 或 ipps://…`、错误 toast 改「应以 ipp:// 或 ipps:// 开头…」、输入框下方新增 hint「ipps:// 走 TLS 加密（自签名证书自动容忍）」④ mDNS 发现项 URI 行改 flex 容器（min-w-0 + span truncate + 徽章 shrink-0），`uri.startsWith('ipps://')` 时追加 Lock+TLS 徽章；导入 `Lock`（lucide-react） |
| `docs/USAGE.md` | 新增「四、ipps://（TLS 加密打印）」整节（①ipps 定义 ②TOFU 自签容忍策略与高安全网络提示 ③直接填 ipps:// 地址即用 ④排查表：ipps 端口/防火墙/老机型未开 TLS ⑤VIPP :3061/:3063 开发测试说明）；原「四、故障排查」顺延为「五」并同步目录 |
| `docs/VENDOR_PROTOCOLS.md` | §4 表第 9 行「待实现」→「OPS 已实现 ✅（ipps://（TLS 自签容忍））」；§7.3 P2 行照 P1 格式标记 ✅ 已完成（client 侧 node:https + rejectUnauthorized:false TOFU；VIPP :3063 测试端点；自测场景 15 ipps-full-flow） |
| `README.md` | 项目目标加 bullet「**ipps:// TLS**：加密 IPP 传输，自签名证书自动容忍（TOFU）」；Self-Test 徽章 14/14→15/15；quick start / 架构图 / 开发测试章节的 :3061 补「+ TLS :3063」；14 场景→15 场景（10 Mock + 5 IPP/mDNS 含 ipps）；Roadmap 第 10 项加「ipps TLS ✔」，第 12 项改为「ipps TLS 真机证书校验」；IPPPrinterBackend 表格说明补 ipps:// |

未触碰：`worklog.md`、`mini-services/ops-host/**`（后端已完成）、路由（无新增）。

## 验证结果（全部通过）

1. `bun run lint` → **0 error 0 warning**（exit 0）
2. `curl http://localhost:3001/api/vipp/printers` → `"port":3061,"tlsPort":3063` ✓；`/api/system/info` → `"vippTlsPort":3063` ✓；场景数 15（含 `ipps-full-flow`）✓
3. dev.log → `GET / 200`（compile 96ms）连续成功，无编译错误（开头 EADDRINUSE 为 init 脚本重复起服务的旧日志，非本次问题）
4. agent-browser（http://localhost:81/，全新浏览器实例）：
   - 打印后端 tab：横向溢出 = 0；`ipps://localhost:3063` 文本存在；`TLS :3063` 面板徽章存在；hint/placeholder 断言通过；page errors = []（注：复用旧浏览器实例时会看到历史 stale chunk 的 `FadingScrollArea is not defined` QueueView 报错，全新实例 0 error，且打印队列 tab 实测渲染正常——非本次引入）
   - mDNS 扫描（打印后端 tab「扫描 _ipp._tcp」）点击成功、发现 vipp 打印机、溢出 0
   - 发现主机 tab：扫描局域网执行成功，溢出 0
   - 概览 tab：`v0.3.0` 文本存在，溢出 0
   - 移动端 393×852（打印后端 tab）：溢出 0，ipps://localhost:3063 仍可见
   - 视口已恢复 1280×800，最终 errors = []

## 备注

- mDNS 发现的 vipp 条目 URI 为 `ipp://`（自通告走 :3061），TLS 徽章按 `uri.startsWith('ipps://')` 条件渲染，本环境不触发属预期；样式遵循该视图既有 min-w-0/shrink-0 溢出约束。
- 全部 UI 文案中文；未使用 indigo/blue 新配色（徽章用 emerald/amber/secondary 既有色系）。
