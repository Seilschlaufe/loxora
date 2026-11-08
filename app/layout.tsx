import type { Metadata, Viewport } from "next";
import "./style.css";
export const metadata: Metadata = {
  title: "Lexora — читать и понимать",
  description:
    "Иностранные тексты, понятные слова. Личный словарь и контекстный анализ.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Lexora" },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#274f45",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
