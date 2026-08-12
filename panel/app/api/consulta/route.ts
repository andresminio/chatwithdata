import { NextRequest, NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { construirContextoSistema } from "@/lib/context";
import { validarSql } from "@/lib/sql-guard";
import { ejecutarSelect } from "@/lib/db";

// Modelo detrás de una variable de entorno (4.2 del proyecto): cambiar de
// proveedor o de versión de Gemini no debería tocar código.
// Default: gemini-3.5-flash-lite. Los Flash "completos" (3.6, 3.5, 2.5, 3)
// comparten el mismo techo gratuito de 5 RPM / 20 RPD, que dos llamadas por
// pregunta agotan en minutos. Los "Flash Lite" de la línea 3.x tienen 15 RPM
// / 500 RPD — mucho más margen para probar o mostrar el piloto sin pagar.
// Contrapartida: puede perder algo de precisión frente al Flash completo;
// si aparecen SQL mal traducidos o redacciones pobres, es lo primero a
// revisar antes de volver a un Flash completo (y ahí sí, pagar el plan).
const MODELO = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

const LIMITE_FILAS_PARA_REDACCION = 50;

// Ninguno de los dos pasos necesita razonamiento profundo: traducir a SQL es
// una tarea acotada (esquema fijo, una sola tabla) y redactar es transcribir
// filas ya calculadas. "minimal" es lo que más achica la latencia percibida
// con Gemini 3.x, que por default piensa en nivel "medium".
const SIN_RAZONAMIENTO_PROFUNDO = {
  google: { thinkingConfig: { thinkingLevel: "minimal" as const } },
};

// El plan gratuito de Gemini limita a 20 solicitudes/minuto, y cada pregunta
// dispara dos llamadas (traducción a SQL + redacción). En una sesión de
// prueba o demo se llega a ese límite fácil — hay que distinguirlo de un
// error real y decirle al usuario que puede reintentar en unos segundos.
function esErrorDeCuota(error: unknown): boolean {
  const texto = String(error);
  return /429|quota exceeded|rate limit|RESOURCE_EXHAUSTED/i.test(texto);
}

function segundosParaReintentar(error: unknown): number | null {
  const match = String(error).match(/retry in ([\d.]+)\s*s/i);
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

const esquemaRespuestaModelo = z.object({
  tipo: z.enum(["sql", "fuera_de_alcance"]),
  sql: z
    .string()
    .optional()
    .describe("Sentencia SELECT si tipo = 'sql'. Omitir si es fuera_de_alcance."),
  mensaje: z
    .string()
    .optional()
    .describe(
      "Si tipo = 'fuera_de_alcance': explicación breve de por qué, en español neutro, sin opinar."
    ),
});

export async function POST(req: NextRequest) {
  let pregunta: string;
  try {
    const body = await req.json();
    pregunta = String(body?.pregunta ?? "").trim();
  } catch {
    return NextResponse.json({ error: "No pudimos procesar la consulta. Intentá nuevamente." }, { status: 400 });
  }

  if (!pregunta) {
    return NextResponse.json({ error: "Escribí una pregunta para poder ayudarte." }, { status: 400 });
  }

  // --- Paso 3-4: encuadre + traducción a SQL en una sola llamada ---------
  let decision: z.infer<typeof esquemaRespuestaModelo>;
  try {
    const resultado = await generateObject({
      model: google(MODELO),
      schema: esquemaRespuestaModelo,
      system: construirContextoSistema(),
      prompt: pregunta,
      providerOptions: SIN_RAZONAMIENTO_PROFUNDO,
    });
    decision = resultado.object;
  } catch (error) {
    if (esErrorDeCuota(error)) {
      const segundos = segundosParaReintentar(error);
      return NextResponse.json(
        {
          error: segundos
            ? `Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en unos ${segundos} segundos.`
            : "Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en un minuto.",
          detalle: String(error),
          reintentable: true,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      {
        error: "No pudimos procesar tu consulta. Intentá reformularla o probar con otra pregunta.",
        detalle: String(error),
      },
      { status: 502 }
    );
  }

  if (decision.tipo === "fuera_de_alcance") {
    return NextResponse.json({
      respuesta:
        decision.mensaje ??
        "Esta consulta no puede responderse con la información disponible. Los datos corresponden a candidaturas y precandidaturas electorales.",
      sql: null,
      filas: [],
    });
  }

  if (!decision.sql) {
    return NextResponse.json(
      { error: "No pudimos procesar tu consulta. Intentá nuevamente." },
      { status: 502 }
    );
  }

  // --- Paso 5: validar el SQL antes de tocar la base ----------------------
  const validacion = validarSql(decision.sql);
  if (!validacion.valido || !validacion.sql) {
    return NextResponse.json(
      {
        error: "No pudimos procesar esta consulta. Intentá formularla de otra manera.",
        detalle: validacion.motivo,
        sql_original: decision.sql,
      },
      { status: 422 }
    );
  }

  // --- Paso 6: ejecutar contra Postgres ------------------------------------
  let filas: Record<string, unknown>[];
  try {
    const resultado = await ejecutarSelect(validacion.sql);
    filas = resultado.filas;
  } catch (error) {
    return NextResponse.json(
      {
        error: "No pudimos obtener la información en este momento. Intentá nuevamente.",
        detalle: String(error),
        sql: validacion.sql,
      },
      { status: 502 }
    );
  }

  // --- Paso 7: redactar la respuesta a partir de las filas ----------------
  let respuesta: string;
  try {
    const { text } = await generateText({
      model: google(MODELO),
      system:
        "Redactás en español neutro, sin opinar ni calificar, a partir exclusivamente " +
        "de las filas que te paso. Si las filas están vacías, decilo explícitamente y, " +
        "si aplica, explicá si es un caso límite del calendario electoral (ver contexto) " +
        "en vez de asumir que no hay datos. No inventes cifras que no estén en las filas. " +
        "El campo genero vale 'F' o 'M': en la prosa escribí siempre 'Femenino' o " +
        "'Masculino', nunca 'Género F', 'Género M' ni combinaciones como 'F (Femenino)'. " +
        "Para resaltar una cifra o categoría clave usá **negrita** (con asteriscos dobles), " +
        "sin abusar. Si el desglose tiene entre 3 y 5 categorías, presentalo como una lista " +
        "con cada ítem en una línea nueva que empiece con '- '; en cada ítem poné en negrita " +
        "el nombre de la categoría, no la cifra, por ejemplo '- **Diputados Nacionales:** 63'. " +
        "Si el desglose tiene más de 5 categorías, NO las listes una por una en la prosa " +
        "(esas filas ya se muestran completas en la tabla debajo de la respuesta): dá el " +
        "total general y como máximo destacá las 2 o 3 categorías con mayor valor, y cerrá " +
        "remitiendo a la tabla para el resto, por ejemplo 'El detalle completo por distrito " +
        "está en la tabla debajo'. Evitá otros símbolos de markdown (títulos, tablas, " +
        "comillas de cita).",
      prompt: [
        `Pregunta original: ${pregunta}`,
        `SQL ejecutado: ${validacion.sql}`,
        `Filas devueltas (máximo ${LIMITE_FILAS_PARA_REDACCION} mostradas de ${filas.length}):`,
        JSON.stringify(filas.slice(0, LIMITE_FILAS_PARA_REDACCION), null, 2),
      ].join("\n\n"),
      providerOptions: SIN_RAZONAMIENTO_PROFUNDO,
    });
    respuesta = text;
  } catch (error) {
    // Si falla la redacción, igual devolvemos el SQL y las filas: son el
    // dato auditable (4.1 principio rector). La prosa es accesorio.
    respuesta = esErrorDeCuota(error)
      ? "Llegamos al límite de consultas a la IA por el momento, pero podés ver la información que buscabas a continuación."
      : "Podés ver la información que buscabas a continuación.";
  }

  return NextResponse.json({
    respuesta,
    sql: validacion.sql,
    filas,
  });
}
