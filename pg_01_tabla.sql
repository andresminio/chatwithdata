-- ============================================================================
-- Tabla cruda: candidaturas UEEDA 2011-2025
--
-- Todas las columnas TEXT a proposito: espejo fiel de la planilla. El tipado
-- vive en la vista, donde se puede leer y corregir, no escondido en la carga.
--
-- Ejecutar antes de cargar_postgres.py, desde el SQL Editor de Supabase o:
--   psql "$DATABASE_URL" -f pg_01_tabla.sql
-- ============================================================================

DROP VIEW  IF EXISTS v_candidaturas;
DROP TABLE IF EXISTS candidaturas;

CREATE TABLE candidaturas (
  eleccion            text,
  etapa               text,
  id_eleccion         text,
  label_eleccion      text,
  fecha_eleccion      text,
  id_distrito         text,
  distrito            text,
  tipo_eleccion       text,
  codigo_ap           text,  -- conserva ceros a la izquierda: '047', no 47
  ap                  text,
  nombre_lista        text,
  cargo               text,
  subcategoria_cargo  text,
  posicion            text,
  id_candidato        text,
  genero              text,
  dni                 text,
  apellido            text,
  nombres             text,
  candidatura         text,
  fecha_nacimiento    text
);

COMMENT ON TABLE candidaturas IS
  'Capa cruda. Precandidaturas (PASO) y candidaturas (generales y segunda '
  'vuelta) 2011-2025, una fila por persona, cargo, lista e instancia. '
  'Origen: UEEDA Precandidaturas y Candidaturas 2011 2025 v141025.xlsx, Sheet1. '
  'No consultar desde la aplicacion: usar la vista v_candidaturas.';
