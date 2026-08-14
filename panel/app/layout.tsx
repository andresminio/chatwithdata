import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chateá con los datos electorales",
  description: "Información sobre candidaturas nacionales en lenguaje natural.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
