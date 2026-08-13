-- ============================================================================
-- Total real y truncamiento por consulta (Postgres / Supabase)
--
-- Suma a consultas_log el total real de registros que cumplían la consulta
-- (sin el LIMIT) y si la respuesta se truncó (total > filas mostradas). Es
-- el mismo dato que ahora ve el usuario en la respuesta y en la tabla, para
-- poder auditarlo después en el log.
--
-- Ejecutar en el SQL Editor de Supabase, después de pg_05_renombrar_log.sql.
-- ============================================================================

ALTER TABLE consultas_log
  ADD COLUMN IF NOT EXISTS total_registros integer,
  ADD COLUMN IF NOT EXISTS truncado boolean NOT NULL DEFAULT false;
