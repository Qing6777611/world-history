import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "纪元 · 世界历史地图",
  description: "拨动地球，穿梭时间，探索同一时刻的世界。世界历史交互原型。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
