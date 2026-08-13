import { NextRequest, NextResponse } from "next/server";
import { marcarConsultaReportada } from "@/lib/db";

// Marca en consultas_log que un usuario reportó un problema con esa
// respuesta puntual ("¿Encontraste un problema? Reportalo acá" en el panel).
// No guarda quién lo reportó, solo que se reportó y cuándo.
export async function POST(req: NextRequest) {
  let logId: unknown;
  try {
    const body = await req.json();
    logId = body?.logId;
  } catch {
    return NextResponse.json({ error: "No pudimos procesar el reporte." }, { status: 400 });
  }

  const id = Number(logId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Falta identificar qué consulta se reporta." }, { status: 400 });
  }

  const marcado = await marcarConsultaReportada(id);
  return NextResponse.json({ ok: marcado });
}
