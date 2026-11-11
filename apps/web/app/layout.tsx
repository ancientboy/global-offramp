import type { Metadata } from "next";
import "./styles.css";
export const metadata: Metadata = {
  title: "汇途 · MOCK 钱包结汇工作台",
  description: "Mock-only operations workbench. No real funds.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
