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
