import { NextRequest, NextResponse } from "next/server";
import { validarSql } from "@/lib/sql-guard";
import { obtenerConsultaConResumenFallido, registrarConsulta } from "@/lib/db";
import { ejecutarConTotal, mensajeResumenFallido, redactarRespuesta } from "@/lib/respuesta";

// Mismo margen que /api/consulta: la redacción pasa por la rotación de modelos.
export const maxDuration = 60;

/**
 * "Reintentar resumen": vuelve a pedir SOLO la redacción de una consulta
 * cuya tabla ya se mostró pero cuyo resumen falló (alcance =
 * 'error_redaccion'). No repite la traducción a SQL.
 *
 * Recibe únicamente el logId. La pregunta y el SQL se leen de consultas_log
 * y el SQL se vuelve a validar y ejecutar (las filas no se aceptan desde el
 * navegador): así este endpoint no sirve para correr consultas arbitrarias.
 *
 * No guarda en la caché: la entrada de caché necesita la explicación del SQL,
 * que no está en el log. La próxima vez que alguien haga la misma pregunta se
 * calcula completa y ahí sí se cachea.
 */
export async function POST(req: NextRequest) {
  let logId: unknown;
  try {
    const body = await req.json();
    logId = body?.logId;
  } catch {
    return NextResponse.json({ error: "No pudimos procesar el pedido." }, { status: 400 });
  }

  const id = Number(logId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Falta identificar qué consulta resumir." }, { status: 400 });
  }

  const consulta = await obtenerConsultaConResumenFallido(id);
  if (!consulta) {
    return NextResponse.json({ error: "No encontramos esa consulta para resumir." }, { status: 404 });
  }

  const validacion = validarSql(consulta.sql);
  if (!validacion.valido || !validacion.sql) {
    return NextResponse.json({ error: "No encontramos esa consulta para resumir." }, { status: 404 });
  }

  try {
    const { filas, total, truncado } = await ejecutarConTotal(validacion.sql, validacion.limite ?? 1000);
    const respuesta = await redactarRespuesta({
      pregunta: consulta.pregunta,
      sql: validacion.sql,
      filas,
      total,
      truncado,
    });
    const nuevoLogId = await registrarConsulta({
      pregunta: consulta.pregunta,
      sqlGenerado: validacion.sql,
      resultado: "ok_resumen_reintentado",
      filasDevueltas: filas.length,
      totalRegistros: total,
      truncado,
    });
    return NextResponse.json({ respuesta, resumenFallido: false, logId: nuevoLogId ?? id });
  } catch (error) {
    console.error("Falló el reintento del resumen:", error);
    return NextResponse.json({ respuesta: mensajeResumenFallido(error), resumenFallido: true, logId: id });
  }
}
