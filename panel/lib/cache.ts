import { createHash } from "node:crypto";
import { obtenerPool } from "@/lib/db";

/**
 * Caché de respuestas completas (SQL + explicación + prosa + filas) por
 * pregunta, en la tabla respuestas_cache de Postgres.
 *
 * Por qué funciona: los datos de v_candidaturas no cambian entre cargas, así
 * que la misma pregunta produce siempre la misma respuesta. Una pregunta
 * repetida (por ejemplo, la de un chip de ejemplo) se sirve de la tabla sin
 * gastar las dos llamadas a Gemini.
 *
 * Invalidación:
 *   - Si cambia el prompt (context.ts o el de redacción), cambia `version` y
 *     las entradas viejas dejan de coincidir solas. No hace falta borrarlas.
 *   - Si se recargan los datos, cargar_postgres.py vacía la tabla.
 *
 * Solo se guardan respuestas exitosas: nunca errores, fuera de alcance ni
 * respuestas cuya redacción falló.
 *
 * Si la tabla no existe o la base falla, la caché se ignora y la consulta
 * sigue por el camino normal: nunca tira abajo una respuesta.
 */

export interface RespuestaCacheada {
  respuesta: string;
  sql: string;
  explicacionSql: string | null;
  filas: Record<string, unknown>[];
  total: number | null;
  truncado: boolean;
  limite: number;
}

/**
 * Normaliza la pregunta para que diferencias triviales no generen entradas
 * distintas: mayúsculas, espacios de más, signos de pregunta al principio y
 * al final. No toca tildes ni palabras: "cuantas" y "cuántas" siguen siendo
 * preguntas distintas a propósito (mejor un miss que devolver algo ajeno).
 */
export function normalizarPregunta(pregunta: string): string {
  return pregunta
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^¿\s*/, "")
    .replace(/\s*\?+$/, "");
}

/** Hash corto que identifica una versión de los prompts. */
export function versionDePrompts(...prompts: string[]): string {
  return createHash("sha256").update(prompts.join("\n\u0000\n")).digest("hex").slice(0, 16);
}

function clave(version: string, pregunta: string): string {
  return createHash("sha256").update(`${version}\n${normalizarPregunta(pregunta)}`).digest("hex");
}

export async function buscarEnCache(version: string, pregunta: string): Promise<RespuestaCacheada | null> {
  try {
    const resultado = await obtenerPool().query<{
      respuesta: string;
      sql: string;
      explicacion_sql: string | null;
      filas: Record<string, unknown>[];
      total: number | null;
      truncado: boolean;
      limite: number;
    }>(
      `UPDATE respuestas_cache
       SET usos = usos + 1, ultimo_uso = now()
       WHERE clave = $1
       RETURNING respuesta, sql, explicacion_sql, filas, total, truncado, limite`,
      [clave(version, pregunta)]
    );
    const fila = resultado.rows[0];
    if (!fila) return null;
    return {
      respuesta: fila.respuesta,
      sql: fila.sql,
      explicacionSql: fila.explicacion_sql,
      filas: fila.filas,
      total: fila.total,
      truncado: fila.truncado,
      limite: fila.limite,
    };
  } catch (error) {
    console.error("No se pudo leer respuestas_cache (se sigue sin caché):", error);
    return null;
  }
}

export async function guardarEnCache(
  version: string,
  pregunta: string,
  datos: RespuestaCacheada
): Promise<void> {
  try {
    await obtenerPool().query(
      `INSERT INTO respuestas_cache
         (clave, version, pregunta, respuesta, sql, explicacion_sql, filas, total, truncado, limite)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (clave) DO NOTHING`,
      [
        clave(version, pregunta),
        version,
        normalizarPregunta(pregunta),
        datos.respuesta,
        datos.sql,
        datos.explicacionSql,
        JSON.stringify(datos.filas),
        datos.total,
        datos.truncado,
        datos.limite,
      ]
    );
  } catch (error) {
    console.error("No se pudo guardar en respuestas_cache:", error);
  }
}
