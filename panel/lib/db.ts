import { Pool } from "pg";

// Un solo pool para todo el proceso. En Vercel (serverless) cada instancia
// de función mantiene el suyo; con el session pooler de Supabase esto es
// lo esperado.
let pool: Pool | undefined;

function obtenerPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("Falta la variable de entorno DATABASE_URL.");
    }
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

const TIMEOUT_MS = 8000;

export interface ResultadoConsulta {
  filas: Record<string, unknown>[];
  columnas: string[];
}

/**
 * Ejecuta un SELECT ya validado, en una transacción explícitamente de solo
 * lectura y con timeout acotado. No usa un rol de Postgres separado
 * (pendiente si esto pasa a producción — ver 6.4/9 del proyecto): la
 * defensa hoy es sql-guard.ts + READ ONLY + statement_timeout.
 */
export async function ejecutarSelect(sql: string): Promise<ResultadoConsulta> {
  const cliente = await obtenerPool().connect();
  try {
    await cliente.query("BEGIN TRANSACTION READ ONLY");
    await cliente.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
    const resultado = await cliente.query(sql);
    await cliente.query("COMMIT");
    return {
      filas: resultado.rows,
      columnas: resultado.fields.map((f) => f.name),
    };
  } catch (error) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

export type ResultadoLog =
  | "ok"
  | "fuera_de_alcance"
  | "error_generacion"
  | "error_validacion"
  | "error_ejecucion"
  | "error_redaccion";

export interface RegistroConsulta {
  pregunta: string;
  sqlGenerado?: string | null;
  resultado: ResultadoLog;
  filasDevueltas?: number | null;
  error?: string | null;
  totalRegistros?: number | null;
  truncado?: boolean;
}

// Fire-and-forget pensado: si falla el registro (por ejemplo la tabla no
// existe todavía en algún ambiente), no tiene que tirar abajo la respuesta
// al usuario. Se loguea a consola y se sigue. Devuelve el id de la fila
// insertada (o null si falló) para que el front pueda, más tarde, marcar
// esa consulta puntual como reportada por el usuario.
export async function registrarConsulta(registro: RegistroConsulta): Promise<number | null> {
  try {
    const resultado = await obtenerPool().query<{ id: number }>(
      `INSERT INTO consultas_log
         (pregunta, sql, alcance, filas_devueltas, error, total_registros, truncado)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        registro.pregunta,
        registro.sqlGenerado ?? null,
        registro.resultado,
        registro.filasDevueltas ?? null,
        registro.error ?? null,
        registro.totalRegistros ?? null,
        registro.truncado ?? false,
      ]
    );
    return resultado.rows[0]?.id ?? null;
  } catch (error) {
    console.error("No se pudo registrar la consulta en consultas_log:", error);
    return null;
  }
}

// Marca una consulta puntual como reportada por un usuario ("encontré un
// problema"). No identifica quién reportó, solo que alguien lo hizo. Devuelve
// false si el id no existe o si falla, para que el endpoint pueda responder
// acorde sin tirar un 500 innecesario.
export async function marcarConsultaReportada(id: number): Promise<boolean> {
  try {
    const resultado = await obtenerPool().query(
      `UPDATE consultas_log
       SET reportado_usuario = true
       WHERE id = $1 AND reportado_usuario = false`,
      [id]
    );
    return (resultado.rowCount ?? 0) > 0;
  } catch (error) {
    console.error("No se pudo marcar la consulta como reportada:", error);
    return false;
  }
}
