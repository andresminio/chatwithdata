-- ============================================================================
-- Reporte de usuario sobre una consulta puntual (Postgres / Supabase)
--
-- Suma dos columnas a consultas_log (ver pg_03_log.sql): si alguien tocó
-- "¿Encontraste un problema? Reportalo acá" debajo de esa respuesta, y
-- cuándo. No identifica quién reportó — sigue siendo anónimo, igual que el
-- resto de la tabla.
--
-- Ejecutar una sola vez, después de pg_03_log.sql:
--   psql "$DATABASE_URL" -f pg_04_reportes.sql
-- (o pegar el contenido en el SQL Editor de Supabase)
-- ============================================================================

ALTER TABLE consultas_log
  ADD COLUMN IF NOT EXISTS reportado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reportado_en timestamptz;

CREATE INDEX IF NOT EXISTS idx_consultas_log_reportado
  ON consultas_log (reportado)
  WHERE reportado = true;
