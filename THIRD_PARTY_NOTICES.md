# 第三方组件与许可证声明

OpenPrintShare 不复制任何第三方源代码，仅以下列发布产物作为依赖集成。升级依赖版本时请同步更新本文件。

| 组件 | 用途 | 许可证 |
|---|---|---|
| [Next.js](https://nextjs.org) / React | Web 控制台框架 | MIT |
| [Tailwind CSS](https://tailwindcss.com) | 样式系统 | MIT |
| [shadcn/ui](https://ui.shadcn.com)（Radix UI primitives） | UI 组件库 | MIT |
| [lucide-react](https://lucide.dev) | 图标（ISC） | ISC |
| [zustand](https://github.com/pmndrs/zustand) | 客户端状态管理 | MIT |
| [socket.io](https://socket.io) / socket.io-client | 实时通信（服务端/客户端） | MIT |
| [pdf-lib](https://pdf-lib.js.org) | 服务端 PDF 解析/生成 | MIT |
| [sonner](https://sonner.emilkowal.ski) | Toast 通知 | MIT |
| [next-themes](https://github.com/pacocoursey/next-themes) | 主题切换 | MIT |
| [Bun](https://bun.sh)（运行时，非分发依赖） | Host 服务运行时 | MIT |
| [Caddy](https://caddyserver.com)（部署示例，deploy/Caddyfile.example） | 反向代理网关 | Apache-2.0 |

## 参考的技术标准（不受版权限制）

- IPP / IPP Everywhere（RFC 8011 等，PWG 标准）
- Bonjour/mDNS/DNS-SD（RFC 6762/6763）
- CUPS（Apple，Apache-2.0 —— 本项目未复制其代码，仅计划通过系统服务/IPP 交互）
- Android Print Framework、AirPrint 为平台公开 API

若后续阶段引入 CUPS 源码或其它 GPL 系组件，须重新评估许可证兼容性并更新本文件。
