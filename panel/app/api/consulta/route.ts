import { NextRequest, NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import { construirContextoSistema } from "@/lib/context";
import { validarSql } from "@/lib/sql-guard";
import { registrarConsulta } from "@/lib/db";
import { conRotacionDeModelos, ErrorIaNoDisponible } from "@/lib/ia";
import { buscarEnCache, guardarEnCache } from "@/lib/cache";
import {
  ejecutarConTotal,
  mensajeResumenFallido,
  redactarRespuesta,
  RAZONAMIENTO_TRADUCCION,
  VERSION_PROMPTS,
} from "@/lib/respuesta";

// Qué modelo de Gemini se usa, y cómo se rota a otro cuando uno está
// saturado o sin cuota: ver lib/ia.ts.

// 60 s es el máximo que Vercel permite sin plan pago. Si se pasa, Vercel
// corta la función y devuelve su propia página de error (504), así que la
// app reparte el tiempo entre las dos llamadas a la IA y corta antes:
// la traducción a SQL tiene que terminar antes del segundo 35 y la
// redacción antes del 52 (lo que queda es margen para la base y el log).
export const maxDuration = 60;
const LIMITE_TRADUCCION_MS = 35_000;
const LIMITE_REDACCION_MS = 52_000;

const esquemaRespuestaModelo = z.object({
  tipo: z.enum(["sql", "fuera_de_alcance"]),
  sql: z
    .string()
    .optional()
    .describe("Sentencia SELECT si tipo = 'sql'. Omitir si es fuera_de_alcance."),
  explicacion: z
    .string()
    .optional()
    .describe(
      "Obligatorio si tipo = 'sql'. Explicación en español neutro, para una persona sin " +
        "conocimientos de SQL, de qué hace la consulta como una secuencia de acciones " +
        "lógicas — no traduzcas la sintaxis, describí el razonamiento. Una sola oración, " +
        "en presente, encadenando los pasos con comas. Ejemplo: 'La consulta agrupa por " +
        "candidato, cuenta en cuántas elecciones participó cada uno, ordena de mayor a " +
        "menor y muestra los 10 con más elecciones.' No menciones nombres de columnas ni " +
        "de tablas ni palabras reservadas de SQL (SELECT, GROUP BY, etc.): describí la " +
        "acción en lenguaje natural (ej. 'agrupa por candidato' en vez de 'agrupa por " +
        "id_candidato', 'filtra por año 2025' en vez de 'WHERE eleccion = 2025')."
    ),
  mensaje: z
    .string()
    .optional()
    .describe(
      "Si tipo = 'fuera_de_alcance': explicación breve de por qué, en español neutro, sin " +
        "opinar, pero con un tono amable y cercano — nunca cortante ni tipo error de sistema " +
        "(evitar frases como 'la pregunta es demasiado ambigua, reformule'). Si el motivo es " +
        "que la pregunta es ambigua o le falta un dato para poder traducirla a SQL (por " +
        "ejemplo, no especifica año, distrito, cargo, o no queda claro si pide personas o " +
        "candidaturas), decí puntualmente QUÉ falta o qué es ambiguo, y cerrá SIEMPRE con un " +
        "ejemplo concreto de cómo reformularla ya resuelta, por ejemplo: 'No me queda claro a " +
        "qué año electoral te referís. ¿Podrías precisarlo? Por ejemplo: \"¿Cuántas mujeres " +
        "encabezaron listas en 2025?\"'. Si en cambio el motivo es que el dato pedido no " +
        "existe en la base (resultados electorales, votos, financiamiento, etc.), explicá " +
        "brevemente qué información sí está disponible en su lugar."
    ),
});

export async function POST(req: NextRequest) {
  const inicio = Date.now();
  let pregunta: string;
  try {
    const body = await req.json();
    pregunta = String(body?.pregunta ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Ups, no pudimos procesar esta consulta. Probá reformularla." }, { status: 400 });
  }

  if (!pregunta) {
    return NextResponse.json({ error: "Escribí una pregunta para poder ayudarte." }, { status: 400 });
  }

  // --- Caché: si esta pregunta ya se respondió con los prompts actuales, se
  // devuelve lo guardado sin llamar a la IA (ver lib/cache.ts) --------------
  const cacheada = await buscarEnCache(VERSION_PROMPTS, pregunta);
  if (cacheada) {
    const logId = await registrarConsulta({
      pregunta,
      sqlGenerado: cacheada.sql,
      resultado: "ok_cache",
      filasDevueltas: cacheada.filas.length,
      totalRegistros: cacheada.total,
      truncado: cacheada.truncado,
    });
    return NextResponse.json({ ...cacheada, logId });
  }

  // --- Paso 3-4: encuadre + traducción a SQL en una sola llamada ---------
  let decision: z.infer<typeof esquemaRespuestaModelo>;
  try {
    const resultado = await conRotacionDeModelos(
      (modelo, signal) =>
        generateObject({
          model: google(modelo),
          schema: esquemaRespuestaModelo,
          system: construirContextoSistema(),
          prompt: pregunta,
          providerOptions: RAZONAMIENTO_TRADUCCION,
          maxRetries: 0, // los reintentos los maneja conRotacionDeModelos
          abortSignal: signal,
        }),
      inicio + LIMITE_TRADUCCION_MS
    );
    decision = resultado.object;
  } catch (error) {
    const logId = await registrarConsulta({
      pregunta,
      resultado: "error_generacion",
      error: String(error),
    });
    // Falla de disponibilidad de la IA (todos los modelos saturados o sin
    // cuota): no tiene sentido pedirle al usuario que reformule la pregunta.
    if (error instanceof ErrorIaNoDisponible) {
      return NextResponse.json(
        {
          error: error.soloCuota
            ? "Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo más tarde."
            : "En este momento el modelo de IA está experimentando alta demanda. Probá de nuevo más tarde.",
          detalle: String(error),
          reintentable: true,
          logId,
        },
        { status: error.soloCuota ? 429 : 503 }
      );
    }
    return NextResponse.json(
      {
        error: "Ups, no pudimos procesar esta consulta. Probá reformularla.",
        detalle: String(error),
        logId,
      },
      { status: 502 }
    );
  }

  if (decision.tipo === "fuera_de_alcance") {
    const logId = await registrarConsulta({ pregunta, resultado: "fuera_de_alcance" });
    return NextResponse.json({
      respuesta:
        decision.mensaje ??
        "Esta consulta no puede responderse con la información disponible. Los datos corresponden a candidaturas y precandidaturas electorales.",
      sql: null,
      filas: [],
      logId,
    });
  }

  if (!decision.sql) {
    const logId = await registrarConsulta({
      pregunta,
      resultado: "error_generacion",
      error: "El modelo no devolvió tipo 'fuera_de_alcance' ni SQL.",
    });
    return NextResponse.json(
      { error: "Ups, no pudimos procesar esta consulta. Probá reformularla.", logId },
      { status: 502 }
    );
  }

  // --- Paso 5: validar el SQL antes de tocar la base ----------------------
  const validacion = validarSql(decision.sql);
  if (!validacion.valido || !validacion.sql) {
    const logId = await registrarConsulta({
      pregunta,
      sqlGenerado: decision.sql,
      resultado: "error_validacion",
      error: validacion.motivo,
    });
    return NextResponse.json(
      {
        error: "Ups, no pudimos procesar esta consulta. Probá reformularla.",
        detalle: validacion.motivo,
        sql_original: decision.sql,
        logId,
      },
      { status: 422 }
    );
  }

  // --- Paso 6: ejecutar contra Postgres ------------------------------------
  const limite = validacion.limite ?? 1000;
  let filas: Record<string, unknown>[];
  let total: number | null;
  let truncado: boolean;
  try {
    ({ filas, total, truncado } = await ejecutarConTotal(validacion.sql, limite));
  } catch (error) {
    const logId = await registrarConsulta({
      pregunta,
      sqlGenerado: validacion.sql,
      resultado: "error_ejecucion",
      error: String(error),
    });
    return NextResponse.json(
      {
        error: "Ups, no pudimos procesar esta consulta. Probá reformularla.",
        detalle: String(error),
        sql: validacion.sql,
        logId,
      },
      { status: 502 }
    );
  }

  // --- Paso 7: redactar la respuesta a partir de las filas ----------------
  // Si falla, igual devolvemos el SQL y las filas: son el dato auditable
  // (4.1 principio rector). La prosa es accesorio, y el usuario puede
  // pedirla de nuevo con "Reintentar resumen" (/api/redactar).
  let respuesta: string;
  let redaccionFallo = false;
  let errorRedaccion: string | null = null;
  try {
    respuesta = await redactarRespuesta({
      pregunta,
      sql: validacion.sql,
      filas,
      total,
      truncado,
      limite: inicio + LIMITE_REDACCION_MS,
    });
  } catch (error) {
    redaccionFallo = true;
    errorRedaccion = String(error);
    respuesta = mensajeResumenFallido(error);
  }

  // Solo se cachea una respuesta completa: si la redacción falló, la próxima
  // vez que alguien pregunte lo mismo conviene volver a intentarla.
  if (!redaccionFallo) {
    await guardarEnCache(VERSION_PROMPTS, pregunta, {
      respuesta,
      sql: validacion.sql,
      explicacionSql: decision.explicacion ?? null,
      filas,
      total,
      truncado,
      limite,
    });
  }

  const logId = await registrarConsulta({
    pregunta,
    sqlGenerado: validacion.sql,
    resultado: redaccionFallo ? "error_redaccion" : "ok",
    error: errorRedaccion,
    filasDevueltas: filas.length,
    totalRegistros: total,
    truncado,
  });

  return NextResponse.json({
    respuesta,
    sql: validacion.sql,
    explicacionSql: decision.explicacion ?? null,
    filas,
    logId,
    total,
    truncado,
    limite,
    resumenFallido: redaccionFallo,
  });
}
