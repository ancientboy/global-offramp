import type { Metadata } from "next";
import "./styles.css";
import "./controls.css";
import "./brand.css";
export const metadata: Metadata = {
  title: "汇途 HUITU · 全球代付",
  description:
    "汇途 HUITU，连接全球价值，管理多币种结算、收款账户与每一笔业务记录。",
  icons: {
    icon: "/brand/flow-app-icon-v2.webp",
    apple: "/brand/flow-app-icon-v2.webp",
  },
};
export const viewport = { themeColor: "#0e2631", colorScheme: "light" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
