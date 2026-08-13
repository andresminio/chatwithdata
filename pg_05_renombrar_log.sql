-- ============================================================================
-- Renombra columnas de consultas_log y elimina reportado_en (Postgres / Supabase)
--
-- reportado_en se saca: el reporte solo puede hacerse en el momento (no hay
-- vista de historial), así que siempre queda a segundos de creado_en y no
-- aporta nada que reportado_usuario = true ya no diga.
--
-- Ejecutar en el SQL Editor de Supabase, después de pg_04_reportes.sql.
-- ============================================================================

ALTER TABLE consultas_log RENAME COLUMN creado_en TO creado;
ALTER TABLE consultas_log RENAME COLUMN sql_generado TO sql;
ALTER TABLE consultas_log RENAME COLUMN resultado TO alcance;
ALTER TABLE consultas_log RENAME COLUMN reportado TO reportado_usuario;

ALTER TABLE consultas_log DROP COLUMN IF EXISTS reportado_en;

ALTER INDEX IF EXISTS idx_consultas_log_creado_en RENAME TO idx_consultas_log_creado;
ALTER INDEX IF EXISTS idx_consultas_log_resultado RENAME TO idx_consultas_log_alcance;
ALTER INDEX IF EXISTS idx_consultas_log_reportado RENAME TO idx_consultas_log_reportado_usuario;
