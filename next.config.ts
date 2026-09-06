import type { NextConfig } from "next";

/**
 * 两种构建形态：
 *  - 默认（standalone）：服务器部署 / Docker 镜像
 *  - OPS_EXPORT=1（export）：静态导出到 out/，随 Host 单文件可执行分发（打包产物形态）
 */
const isStaticExport = process.env.OPS_EXPORT === "1";

const nextConfig: NextConfig = isStaticExport
  ? {
      output: "export",
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
      env: {
        // 打包产物：直连模式（REST 同源，WS 绝对端口）
        NEXT_PUBLIC_OPS_DIRECT: "1",
      },
    }
  : {
      output: "standalone",
      /* config options here */
      typescript: {
        ignoreBuildErrors: true,
      },
      reactStrictMode: false,
    };

export default nextConfig;
