-- ============================================================================
-- Registro de consultas del panel de chat (Postgres / Supabase)
--
-- Cada pregunta que llega a /api/consulta queda una fila acá: la pregunta
-- original, el SQL que generó el modelo (si llegó a generarlo), qué pasó
-- (ok / fuera de alcance / algún tipo de error) y cuántas filas devolvió.
-- Es la base para: (a) que el equipo pueda revisar en conjunto qué se
-- preguntó y dónde el modelo interpretó mal algo, y (b) decidir más
-- adelante qué preguntas conviene cachear.
--
-- No identifica quién pregunta: no hay login en el panel, así que esto es
-- anónimo por diseño. Si más adelante se agrega usuario, sumar la columna acá.
--
-- Ejecutar una sola vez, después de pg_02_vista.sql:
--   psql "$DATABASE_URL" -f pg_03_log.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS consultas_log (
  id                bigserial PRIMARY KEY,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  pregunta          text NOT NULL,
  sql_generado      text,
  resultado         text NOT NULL,
  -- 'ok' | 'fuera_de_alcance' | 'error_generacion' | 'error_validacion' |
  -- 'error_ejecucion' | 'error_redaccion' (esta última sí devuelve datos al
  -- usuario, solo falló la prosa — ver route.ts paso 7)
  filas_devueltas   integer,
  error             text
);

CREATE INDEX IF NOT EXISTS idx_consultas_log_creado_en ON consultas_log (creado_en);
CREATE INDEX IF NOT EXISTS idx_consultas_log_resultado ON consultas_log (resultado);

COMMENT ON TABLE consultas_log IS
  'Historial de preguntas hechas al panel de chat, con el SQL generado y el '
  'resultado de cada paso. Anónimo: no guarda quién preguntó.';
