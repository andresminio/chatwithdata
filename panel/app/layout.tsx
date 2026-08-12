import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Candidaturas electorales — consulta",
  description: "Piloto interno: consulta en lenguaje natural sobre candidaturas 2011–2025.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
