import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenPrintShare — 跨平台局域网共享打印机",
  description:
    "OpenPrintShare (OPS)：设备 A 安装 Host 共享系统打印机，Windows / macOS / Linux / Android / iOS 自动发现并打印。MVP 内置 Virtual Printer（MockPrinterBackend），无需真实打印机即可完整演示。",
  keywords: ["OpenPrintShare", "OPS", "打印机共享", "CUPS", "IPP", "AirPrint", "mDNS", "Virtual Printer"],
  authors: [{ name: "OpenPrintShare" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "OpenPrintShare",
    description: "跨平台局域网共享打印机 · Virtual Printer 演示环境",
    siteName: "OpenPrintShare",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
          <Toaster richColors position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
