-- ============================================================================
-- Reordena las columnas de consultas_log (Postgres / Supabase)
--
-- Postgres no tiene un "ALTER TABLE ... reordenar columna" (a diferencia de
-- MySQL): la única forma es recrear la tabla con el orden que se quiere y
-- copiar los datos. Como consultas_log es chica y no tiene relaciones con
-- otras tablas, es seguro.
--
-- Orden final: id, creado, pregunta, sql, alcance, total_registros,
-- filas_devueltas, truncado, error, reportado_usuario.
--
-- Ejecutar en el SQL Editor de Supabase, después de pg_06_total_truncado.sql.
-- ============================================================================

CREATE TABLE consultas_log_nueva (
  id                bigserial PRIMARY KEY,
  creado            timestamptz NOT NULL DEFAULT now(),
  pregunta          text NOT NULL,
  sql               text,
  alcance           text NOT NULL,
  total_registros   integer,
  filas_devueltas   integer,
  truncado          boolean NOT NULL DEFAULT false,
  error             text,
  reportado_usuario boolean NOT NULL DEFAULT false
);

INSERT INTO consultas_log_nueva
  (id, creado, pregunta, sql, alcance, total_registros, filas_devueltas, truncado, error, reportado_usuario)
SELECT
  id, creado, pregunta, sql, alcance, total_registros, filas_devueltas, truncado, error, reportado_usuario
FROM consultas_log;

-- La sequence del id nuevo arranca en 1: hay que empujarla después de copiar,
-- para que el próximo insert no choque con ids que ya existían.
SELECT setval(
  pg_get_serial_sequence('consultas_log_nueva', 'id'),
  COALESCE((SELECT MAX(id) FROM consultas_log_nueva), 1),
  true
);

DROP TABLE consultas_log;
ALTER TABLE consultas_log_nueva RENAME TO consultas_log;

CREATE INDEX IF NOT EXISTS idx_consultas_log_creado ON consultas_log (creado);
CREATE INDEX IF NOT EXISTS idx_consultas_log_alcance ON consultas_log (alcance);
CREATE INDEX IF NOT EXISTS idx_consultas_log_reportado_usuario
  ON consultas_log (reportado_usuario)
  WHERE reportado_usuario = true;

COMMENT ON TABLE consultas_log IS
  'Historial de preguntas hechas al panel de chat, con el SQL generado y el '
  'resultado de cada paso. Anónimo: no guarda quién preguntó.';
