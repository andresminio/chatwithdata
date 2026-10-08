import { google } from "@ai-sdk/google";
import { generateText } from "ai";
import { construirContextoSistema } from "@/lib/context";
import { paraContarTotal } from "@/lib/sql-guard";
import { ejecutarSelect } from "@/lib/db";
import { conRotacionDeModelos, ErrorIaNoDisponible } from "@/lib/ia";
import { versionDePrompts } from "@/lib/cache";

/**
 * Piezas compartidas entre /api/consulta (la pregunta completa) y
 * /api/redactar (reintentar solo el resumen cuando la redacción falló):
 * ejecutar el SQL con su total, y redactar la respuesta a partir de filas.
 */

const LIMITE_FILAS_PARA_REDACCION = 50;

// Traducir a SQL es una tarea acotada (esquema fijo, una sola tabla) y con
// "minimal" funciona bien: es lo que más achica la latencia con Gemini 3.x,
// que por default piensa en nivel "medium". Se usa en /api/consulta.
export const SIN_RAZONAMIENTO_PROFUNDO = {
  google: { thinkingConfig: { thinkingLevel: "minimal" as const } },
};

// La redacción sí necesita razonar: tiene que contrastar las filas contra el
// SQL ejecutado y contra una lista cerrada de hechos del calendario, con
// muchas reglas condicionales. Con "minimal" daba respuestas sin cifras y
// motivos inventados para resultados vacíos (auditoría de chips, 2026-10-08).
// Tiene margen de tiempo: la traducción termina en ~3 s y la redacción puede
// llegar hasta el segundo 52 (ver LIMITE_REDACCION_MS en route.ts).
const RAZONAMIENTO_REDACCION = {
  google: { thinkingConfig: { thinkingLevel: "medium" as const } },
};

// Instrucciones de la segunda llamada (redacción de la respuesta a partir
// de las filas). Constante de módulo para poder calcular VERSION_PROMPTS.
const SISTEMA_REDACCION =
  "Redactás en español neutro, sin opinar ni calificar, a partir exclusivamente " +
  "de las filas que te paso. " +
  "DATO PRIMERO: la primera oración de la respuesta SIEMPRE da al menos un dato " +
  "concreto sacado de las filas (un total, la cifra más alta, una comparación, el valor " +
  "del primer y del último año). Las aclaraciones sobre qué abarca la consulta y la " +
  "remisión a la tabla van DESPUÉS de ese dato, nunca solas: una respuesta hecha solo de " +
  "aclaraciones o de 'el detalle está en la tabla debajo' es incorrecta. Si los " +
  "resultados están truncados, el dato concreto es la cantidad total que te paso. " +
  "SOLO LO QUE ESTÁ EN EL SQL: no afirmes nada sobre años, etapas, cargos, distritos o " +
  "géneros que no esté en el WHERE del SQL ejecutado o en las columnas de las filas. Por " +
  "ejemplo, si el SQL no filtra por etapa, no digas que los datos son de PASO ni de " +
  "Generales. Si el SQL usa un año, cargo, etapa o distrito distinto del que nombra la " +
  "primera parte de la pregunta (porque la persona lo cambió con los filtros, que llegan " +
  "entre paréntesis al final), decilo en una frase al empezar, por ejemplo: 'Aunque la " +
  "pregunta menciona 2025, los datos corresponden a 2023, el año elegido en los filtros.' " +
  "FILAS VACÍAS: solo si te paso 0 filas. Si hay al menos una fila, NUNCA digas que las " +
  "filas están vacías ni que faltan datos. Con 0 filas, explicá el motivo SOLO si coincide " +
  "con uno de estos hechos, contrastándolo con los filtros del SQL ejecutado: no hubo PASO " +
  "en 2025 (ese año solo hubo Generales); Parlamentarios del Mercosur solo se eligieron en " +
  "2015 y 2023; Presidente y Vice solo en 2011, 2015, 2019 y 2023; segunda vuelta solo en " +
  "2015 y 2023; Senadores Nacionales: cada distrito elige senadores cada 6 años, y en cada " +
  "año eligen solo 8 distritos (2011, 2017 y 2023: Buenos Aires, Formosa, Jujuy, La Rioja, " +
  "Misiones, San Juan, San Luis y Santa Cruz; 2013, 2019 y 2025: CABA, Chaco, Entre Ríos, " +
  "Neuquén, Río Negro, Santiago del Estero, Salta y Tierra del Fuego; 2015 y 2021: " +
  "Catamarca, Chubut, Corrientes, Córdoba, La Pampa, Mendoza, Santa Fe y Tucumán). " +
  "Nombrá el hecho concreto que aplica (por ejemplo 'En 2025 no hubo PASO' o 'Buenos " +
  "Aires no eligió senadores en 2025; ese año los eligieron CABA, Chaco, …'). Si ninguno " +
  "de estos hechos coincide con los filtros del SQL, decí solamente que no hay " +
  "candidaturas que cumplan esos criterios, sin inventar un motivo. NUNCA uses las " +
  "expresiones internas 'caso límite', 'caso límite del calendario electoral' ni 'ver " +
  "contexto' en la respuesta. " +
  "REGLA POR DEFECTO, la más frecuente: si la pregunta compara Varones y Mujeres, o " +
  "Femenino y Masculino (por ejemplo 'paridad de género', 'cuántas mujeres', 'por " +
  "género', evolución de género en listas o candidaturas), respondé ÚNICAMENTE en base " +
  "a los datos de las filas, como cualquier otra consulta. NO agregues ninguna " +
  "aclaración sobre género no binario en este caso — el solo hecho de que la pregunta " +
  "contenga la palabra 'género' NO activa la excepción que sigue. " +
  "EXCEPCIÓN (poco frecuente, no confundir con la regla de arriba): tratalo así aunque " +
  "las filas no estén vacías, solo si la pregunta en sí misma menciona explícitamente " +
  "'género no binario', 'sin género', o cualquier identidad de género distinta de " +
  "mujer/varón — no alcanza con que la pregunta hable de género en general. En ese caso " +
  "puntual, respondé primero con los datos reales de las filas igual que siempre (esta " +
  "aclaración se agrega, nunca reemplaza la respuesta con datos) y después agregá, de " +
  "forma textual y explícita, esta frase (no la parafrasees, es un tema sensible por la " +
  "invisibilización): 'Al momento, no se identificaron candidaturas de personas con " +
  "género no binario registrado en su DNI.' " +
  "Caso distinto (no confundir con los dos anteriores): si la pregunta usa términos de " +
  "identidad de género u orientación sexual que no son una categoría registral de " +
  "género (por ejemplo travesti, trans, transexual, gay, puto, marica, lesbiana, " +
  "torta, queer, bisexual, u otros equivalentes), la base directamente no releva ese " +
  "dato — no es que falten filas, es que esa dimensión no existe en la fuente. " +
  "Aclará explícitamente que la base contiene únicamente el género registrado de los " +
  "candidatos (el que consta en el DNI) y no releva otros aspectos de su identidad de " +
  "género u orientación sexual. No lo trates como un hueco de datos de esta consulta " +
  "puntual ni devuelvas una tabla vacía sin esa explicación. " +
  "No inventes " +
  "cifras que no estén en las filas. " +
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
  "haya pedido así de forma explícita, decilo con tus propias palabras después del dato principal (nunca en " +
  "su lugar), mencionando ÚNICAMENTE las dimensiones que realmente varían en esta " +
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
  "pregunta haya usado el modo Listado o el modo Totales.";

// Identifica la versión actual de los dos prompts. Entra en la clave de la
// caché: si cambia context.ts o SISTEMA_REDACCION, las respuestas cacheadas
// con el prompt anterior dejan de usarse solas.
export const VERSION_PROMPTS = versionDePrompts(construirContextoSistema(), SISTEMA_REDACCION);

export interface ResultadoEjecucion {
  filas: Record<string, unknown>[];
  total: number | null;
  truncado: boolean;
}

/**
 * Ejecuta un SELECT ya validado y calcula cuántas filas hay en total sin el
 * LIMIT. Si falla la consulta principal, tira el error (lo maneja quien
 * llama); si falla solo el conteo, sigue sin el dato.
 */
export async function ejecutarConTotal(sql: string, limite: number): Promise<ResultadoEjecucion> {
  const { filas } = await ejecutarSelect(sql);

  // Cuánto hay en total detrás de esta consulta, sin el LIMIT — para poder
  // decirle al usuario el número real, no solo si "hay más o no". Si esto
  // falla, no tiene que tirar abajo la respuesta: seguimos sin el dato.
  let total: number | null = null;
  try {
    const conteo = await ejecutarSelect(paraContarTotal(sql));
    const valor = conteo.filas[0]?.total;
    total = typeof valor === "number" ? valor : Number(valor);
    if (!Number.isFinite(total)) total = null;
  } catch (error) {
    console.error("No se pudo calcular el total de resultados:", error);
  }

  // Solo se considera "truncado" cuando se pegó contra el tope de seguridad
  // de 1000 filas (el default que agrega sql-guard cuando el modelo no puso
  // LIMIT). Un LIMIT chico puesto a propósito por el modelo (ej. "el partido
  // con más listas" → LIMIT 1, o "los 10 candidatos con más postulaciones" →
  // LIMIT 10) no es un truncamiento: es exactamente lo que se pidió, y no
  // tiene sentido sugerirle al usuario el modo "Totales" en ese caso.
  const truncado = limite >= 1000 && (total != null ? total > filas.length : filas.length >= limite);

  return { filas, total, truncado };
}

/** Segunda llamada a la IA: redacta la respuesta en prosa. Tira si falla. */
export async function redactarRespuesta({
  pregunta,
  sql,
  filas,
  total,
  truncado,
  limite,
}: {
  pregunta: string;
  sql: string;
  filas: Record<string, unknown>[];
  total: number | null;
  truncado: boolean;
  /** Timestamp (ms) antes del cual tiene que terminar (ver lib/ia.ts). */
  limite: number;
}): Promise<string> {
  const { text } = await conRotacionDeModelos((modelo, signal) =>
    generateText({
      model: google(modelo),
      maxRetries: 0, // los reintentos los maneja conRotacionDeModelos
      abortSignal: signal,
      system: SISTEMA_REDACCION,
      prompt: [
        `Pregunta original: ${pregunta}`,
        `SQL ejecutado: ${sql}`,
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
      providerOptions: RAZONAMIENTO_REDACCION,
    }),
    limite
  );
  return text;
}

/**
 * Texto que va en el lugar del resumen cuando la redacción falló. Aclara que
 * lo que falló es SOLO el resumen: la tabla viene de Postgres, no de la IA,
 * así que los datos que se muestran están bien.
 */
export function mensajeResumenFallido(error: unknown): string {
  if (error instanceof ErrorIaNoDisponible) {
    return error.soloCuota
      ? "No pudimos generar el resumen porque se alcanzó el límite de consultas a la IA por el momento. Los resultados de tu consulta están en la tabla de abajo."
      : "No pudimos generar el resumen porque la IA está con alta demanda en este momento. Los resultados de tu consulta están en la tabla de abajo.";
  }
  return "No pudimos generar el resumen en este momento. Los resultados de tu consulta están en la tabla de abajo.";
}
