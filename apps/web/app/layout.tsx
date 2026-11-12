import type { Metadata } from "next";
import "./styles.css";
import "./controls.css";
export const metadata: Metadata = {
  title: "汇途 · 全球代付",
  description: "管理钱包、收款账户、结汇订单与付款记录。",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
