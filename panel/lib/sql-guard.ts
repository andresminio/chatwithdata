/**
 * Validación del SQL que devuelve el modelo antes de ejecutarlo.
 *
 * No hay sqlglot disponible en runtime de Node/Vercel (es una librería
 * Python), así que esto es un guard-rail explícito por reglas, no un parser
 * completo. Cubre lo que pide el punto 4.3 del proyecto: ¿es SELECT?
 * ¿solo v_candidaturas? ¿tiene LIMIT?
 *
 * Pendiente cuando el volumen de tráfico lo justifique: reemplazar por un
 * parser real (node-sql-parser) si este approach empieza a dar falsos
 * negativos.
 */

const PALABRAS_PROHIBIDAS =
  /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|attach|detach|copy|call|execute|do|vacuum|pg_sleep|pg_read_file|dblink)\b/i;

const TABLA_PERMITIDA = "v_candidaturas";

export interface ResultadoValidacion {
  valido: boolean;
  motivo?: string;
  sql?: string;
  limite?: number;
}

export function validarSql(sqlCrudo: string): ResultadoValidacion {
  let sql = sqlCrudo.trim();

  // El modelo a veces envuelve la respuesta en ```sql ... ```
  sql = sql.replace(/^```sql\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  if (!sql) {
    return { valido: false, motivo: "El modelo no devolvió SQL." };
  }

  // Una sola sentencia: permitir un ; final, rechazar cualquier otro.
  const sinPuntoFinal = sql.replace(/;\s*$/, "");
  if (sinPuntoFinal.includes(";")) {
    return { valido: false, motivo: "Se detectó más de una sentencia SQL." };
  }
  sql = sinPuntoFinal;

  if (/--|\/\*/.test(sql)) {
    return { valido: false, motivo: "No se permiten comentarios SQL." };
  }

  // Se permite un SELECT directo, o un SELECT precedido de un WITH (CTEs de
  // solo lectura) — necesario para preguntas que piden valores absolutos y
  // porcentuales a la vez (ej. un CTE con los totales por grupo, y el SELECT
  // final calculando el porcentaje contra ese total). La cláusula WITH en sí
  // no habilita nada peligroso: PALABRAS_PROHIBIDAS más abajo sigue
  // bloqueando cualquier operación de escritura en cualquier parte del texto.
  const empiezaConSelect = /^\s*select\b/i.test(sql);
  const empiezaConWith = /^\s*with\b/i.test(sql) && /\bselect\b/i.test(sql);
  if (!empiezaConSelect && !empiezaConWith) {
    return { valido: false, motivo: "Solo se permiten sentencias SELECT." };
  }

  if (PALABRAS_PROHIBIDAS.test(sql)) {
    return { valido: false, motivo: "El SQL contiene una operación no permitida." };
  }

  // Nombres de CTE definidos en un WITH (si lo hay): se permiten como
  // "tabla" válida en el FROM/JOIN del SELECT final, ya que no son tablas
  // reales sino resultados intermedios definidos en el mismo query.
  const nombresCte = new Set(
    [...sql.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase())
  );

  // Debe referenciar v_candidaturas y ninguna otra tabla identificable
  // después de FROM/JOIN.
  const tablasReferenciadas = [
    ...sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi),
  ].map((m) => m[1].replace(/^public\./i, "").toLowerCase());

  if (tablasReferenciadas.length === 0) {
    return { valido: false, motivo: "No se encontró ninguna cláusula FROM." };
  }

  const tablaInvalida = tablasReferenciadas.find(
    (t) => t !== TABLA_PERMITIDA && !nombresCte.has(t)
  );
  if (tablaInvalida) {
    return {
      valido: false,
      motivo: `Solo se puede consultar ${TABLA_PERMITIDA}, se encontró "${tablaInvalida}".`,
    };
  }

  // Forzar LIMIT si el modelo se lo olvidó.
  if (!/\blimit\s+\d+/i.test(sql)) {
    sql = `${sql} LIMIT 1000`;
  }

  const matchLimite = sql.match(/\blimit\s+(\d+)/i);
  const limite = matchLimite ? parseInt(matchLimite[1], 10) : 1000;

  return { valido: true, sql, limite };
}

/**
 * Envuelve el mismo SQL ya validado en un COUNT(*), sacándole el LIMIT, para
 * saber cuántos registros hay en total detrás de la consulta — no solo si
 * "hay más o no". Así la respuesta puede decir el número real, no un booleano.
 */
export function paraContarTotal(sql: string): string {
  const sinLimite = sql.replace(/\s*\blimit\s+\d+\s*$/i, "");
  return `SELECT COUNT(*)::int AS total FROM (${sinLimite}) AS _conteo`;
}
