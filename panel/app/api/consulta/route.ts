import { NextRequest, NextResponse } from "next/server";
import { google } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { construirContextoSistema } from "@/lib/context";
import { validarSql, paraContarTotal } from "@/lib/sql-guard";
import { ejecutarSelect, registrarConsulta } from "@/lib/db";

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
    const logId = await registrarConsulta({
      pregunta,
      resultado: "error_generacion",
      error: String(error),
    });
    if (esErrorDeCuota(error)) {
      const segundos = segundosParaReintentar(error);
      return NextResponse.json(
        {
          error: segundos
            ? `Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en unos ${segundos} segundos.`
            : "Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en un minuto.",
          detalle: String(error),
          reintentable: true,
          logId,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      {
        error: "No pudimos procesar tu consulta. Intentá reformularla o probar con otra pregunta.",
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
      { error: "No pudimos procesar tu consulta. Intentá nuevamente.", logId },
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
        error: "No pudimos procesar esta consulta. Intentá formularla de otra manera.",
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
  try {
    const resultado = await ejecutarSelect(validacion.sql);
    filas = resultado.filas;
  } catch (error) {
    const logId = await registrarConsulta({
      pregunta,
      sqlGenerado: validacion.sql,
      resultado: "error_ejecucion",
      error: String(error),
    });
    return NextResponse.json(
      {
        error: "No pudimos obtener la información en este momento. Intentá nuevamente.",
        detalle: String(error),
        sql: validacion.sql,
        logId,
      },
      { status: 502 }
    );
  }

  // Cuánto hay en total detrás de esta consulta, sin el LIMIT — para poder
  // decirle al usuario el número real, no solo si "hay más o no". Si esto
  // falla, no tiene que tirar abajo la respuesta: seguimos sin el dato.
  let total: number | null = null;
  try {
    const conteo = await ejecutarSelect(paraContarTotal(validacion.sql));
    const valor = conteo.filas[0]?.total;
    total = typeof valor === "number" ? valor : Number(valor);
    if (!Number.isFinite(total)) total = null;
  } catch (error) {
    console.error("No se pudo calcular el total de resultados:", error);
  }

  const truncado = total != null ? total > filas.length : filas.length >= limite;

  // --- Paso 7: redactar la respuesta a partir de las filas ----------------
  let respuesta: string;
  let redaccionFallo = false;
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
        "Cualquier cifra numérica que menciones (promedios, porcentajes, edades, tasas, " +
        "etc.) va SIEMPRE redondeada a números enteros, sin decimales — por ejemplo '45 " +
        "años' o '38%', nunca '45.3 años' ni '38.24%'. Si una fila trae un valor con " +
        "decimales, redondealo vos al presentarlo. " +
        "ADVERTENCIA IMPORTANTE sobre la aclaración de edad que sigue: es una regla " +
        "CONDICIONAL, no una frase fija para agregar siempre. Revisá primero si las filas " +
        "o la agregación que te paso efectivamente incluyen una edad (una columna o valor " +
        "de edad, promedio de edad, edad mínima/máxima, etc.). Si NO hay ninguna edad " +
        "involucrada en esta consulta puntual (por ejemplo, preguntas sobre listas, " +
        "género, cargos, distritos, cantidad de candidaturas, etc.), NO menciones nada " +
        "sobre edades ni sobre la elección general bajo ningún concepto — omitir por " +
        "completo este tema es lo correcto en ese caso. Solo si la respuesta SÍ menciona " +
        "una edad (promedio, mínima, máxima, o de una persona puntual), aclará que es la " +
        "edad al momento de la elección general de ese año — por ejemplo 'edad promedio " +
        "al momento de la elección general de 2025: 45 años' — nunca la presentes como una " +
        "edad actual o sin esa aclaración, incluso si la pregunta original no lo pidió " +
        "explícitamente. Si la consulta abarca más de un año electoral y sí involucra " +
        "edades, aclaralo una sola vez de forma general (ej. 'las edades están calculadas " +
        "al momento de la elección general de cada año') en vez de repetirlo en cada cifra. " +
        "Para resaltar una cifra o categoría clave usá **negrita** (con asteriscos dobles), " +
        "sin abusar. Si el desglose tiene entre 3 y 5 categorías, presentalo como una lista " +
        "con cada ítem en una línea nueva que empiece con '- '; en cada ítem poné en negrita " +
        "el nombre de la categoría, no la cifra, por ejemplo '- **Diputados Nacionales:** 63'. " +
        "Si el desglose tiene más de 5 categorías, NO las listes una por una en la prosa " +
        "(esas filas ya se muestran en la tabla debajo de la respuesta): dá el total " +
        "general y como máximo destacá las 2 o 3 categorías con mayor valor, y cerrá " +
        "remitiendo a la tabla para el resto. Antes de escribir la respuesta, revisá el SQL " +
        "ejecutado y las columnas/valores presentes en las filas: si la agregación o el " +
        "listado efectivamente abarca más de un año electoral, más de una etapa, más de un " +
        "cargo, o mezcla titulares y suplentes (o presidente/vice) sin que la pregunta lo " +
        "haya pedido así de forma explícita, decilo con tus propias palabras al arrancar la " +
        "respuesta, mencionando ÚNICAMENTE las dimensiones que realmente varían en esta " +
        "consulta puntual. NUNCA repitas una lista fija de dimensiones ('años, etapas, " +
        "cargos, titulares y suplentes') como si fuera una frase hecha: si el SQL filtra " +
        "por una sola etapa (ej. WHERE etapa = 'PASO'), no digas 'varias etapas'; si la " +
        "consulta cuenta listas y no distingue subcategoria, no menciones titulares y " +
        "suplentes, porque esa distinción no aplica a lo que se está contando. Si el prompt " +
        "indica 'Resultados truncados: no', esas filas están completas en la tabla: decilo " +
        "con una frase genérica como 'El detalle completo está en la tabla debajo', sin " +
        "inventar de qué está desglosado (por distrito, por cargo, etc.) salvo que eso sea " +
        "visible en las columnas de las filas que te paso. Si indica 'Resultados truncados: " +
        "sí', la tabla NO tiene todas las filas (solo una selección parcial): NO uses la " +
        "palabra 'completo' para describirla, decí en cambio algo como 'El detalle de estas " +
        "filas está en la tabla debajo'. Evitá otros símbolos de markdown (títulos, tablas, " +
        "comillas de cita). Si el prompt indica 'Resultados truncados: sí' (y SOLO en ese " +
        "caso): te paso 'Cantidad total de filas/categorías que devuelve la consulta " +
        "completa' — es un CONTEO DE FILAS de la consulta sin el límite de la tabla, NO es " +
        "una suma de ninguna columna (por ejemplo, si la consulta agrupa por distrito, ese " +
        "número es la cantidad de distritos que hay en total, no la suma de candidatos de " +
        "todos ellos). Junto con la cantidad exacta que ve el usuario en la tabla ('Filas " +
        "que el usuario ve en la tabla'), mencioná ambos números explícitamente (por ejemplo " +
        "'la consulta completa tiene X filas/categorías, se muestran las primeras N') usando " +
        "ESOS números tal cual te los paso. NO calcules ni afirmes totales, sumas, " +
        "porcentajes o conteos propios a partir de las filas parciales, y NO uses la cantidad " +
        "de filas de muestra que te paso a vos más abajo como si fuera lo que ve el usuario: " +
        "son cosas distintas (a vos te paso menos filas de muestra, por espacio, pero el " +
        "usuario ve más en su tabla). Si además la pregunta pedía un total o una cantidad, " +
        "agregá un PÁRRAFO APARTE (dejá una línea en blanco antes, no lo continúes en el " +
        "mismo párrafo) con exactamente este texto: 'Para obtener una cantidad o un total " +
        "específico, conviene usar el modo \"Totales\" en vez de \"Listado\", y se sugiere " +
        "acotar la consulta filtrando por año electoral, etapa o distrito.' Si el prompt " +
        "indica 'Resultados truncados: no', NO agregues ese párrafo ni menciones el modo " +
        "\"Totales\" en ningún caso: la respuesta ya es completa tal cual, sea que la " +
        "pregunta haya usado el modo Listado o el modo Totales.",
      prompt: [
        `Pregunta original: ${pregunta}`,
        `SQL ejecutado: ${validacion.sql}`,
        `Resultados truncados: ${truncado ? "sí" : "no"}`,
        // Solo se manda esta línea cuando SÍ hay truncamiento: si no, es un
        // número que puede confundir (por ejemplo, en una consulta agrupada
        // por distrito, coincide con la cantidad de distritos, no con la
        // suma de candidatos — y el modelo lo mezcló con eso una vez).
        ...(truncado
          ? [
              `Cantidad total de filas/categorías que devuelve la consulta completa, sin el ` +
                `límite de la tabla (esto es un CONTEO DE FILAS, no la suma de ninguna ` +
                `columna): ${total ?? "desconocido"}`,
            ]
          : []),
        `Filas que el usuario ve en la tabla debajo de tu respuesta: ${filas.length}`,
        `Muestra de esas filas para que redactes (son ${Math.min(LIMITE_FILAS_PARA_REDACCION, filas.length)} de las ${filas.length} que el usuario ve en la tabla, no la cantidad total):`,
        JSON.stringify(filas.slice(0, LIMITE_FILAS_PARA_REDACCION), null, 2),
      ].join("\n\n"),
      providerOptions: SIN_RAZONAMIENTO_PROFUNDO,
    });
    respuesta = text;
  } catch (error) {
    // Si falla la redacción, igual devolvemos el SQL y las filas: son el
    // dato auditable (4.1 principio rector). La prosa es accesorio.
    redaccionFallo = true;
    respuesta = esErrorDeCuota(error)
      ? "Llegamos al límite de consultas a la IA por el momento, pero podés ver la información que buscabas a continuación."
      : "Podés ver la información que buscabas a continuación.";
  }

  const logId = await registrarConsulta({
    pregunta,
    sqlGenerado: validacion.sql,
    resultado: redaccionFallo ? "error_redaccion" : "ok",
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
  });
}
