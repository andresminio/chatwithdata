-- ============================================================================
-- Capa semantica: candidaturas UEEDA 2011-2025  (Postgres / Supabase)
--
-- Es la unica superficie contra la que consulta el chat. El modelo no ve la
-- tabla cruda: ve esto, tipado y con nombres de dominio.
--
-- MATERIALIZADA a proposito: los datos son estaticos, asi que se calcula una
-- sola vez y queda en disco en vez de reprocesarse en cada consulta. Son
-- 38.907 filas, unos 8 MB.
--
--   Si se recargan los datos:  REFRESH MATERIALIZED VIEW v_candidaturas;
--
-- Ejecutar despues de cargar los datos:
--   psql "$DATABASE_URL" -f pg_02_vista.sql
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS v_candidaturas;

CREATE MATERIALIZED VIEW v_candidaturas AS

WITH base AS (
  SELECT
    CASE WHEN eleccion ~ '^\d+$' THEN eleccion::int END        AS eleccion,
    CASE etapa
      WHEN '1' THEN 'PASO'
      WHEN '2' THEN 'Generales'
      WHEN '3' THEN 'Segunda vuelta'
    END                                                        AS etapa,
    CASE WHEN fecha_eleccion ~ '^\d{2}/\d{2}/\d{4}$'
         THEN to_date(fecha_eleccion, 'DD/MM/YYYY') END        AS fecha_eleccion,

    -- ------------------------------------------------------------- lugar
    CASE WHEN id_distrito ~ '^\d+$' THEN id_distrito::int END  AS id_distrito,
    distrito,

    -- -------------------------------------------------------- agrupacion
    -- codigo_ap se asigna por distrito y por eleccion: el mismo numero en
    -- distritos distintos designa agrupaciones distintas.
    codigo_ap                                                  AS codigo_agrupacion,
    ap                                                         AS agrupacion,
    nombre_lista                                               AS lista,

    -- ------------------------------------------------------------- cargo
    cargo,
    -- 'TITULAR' (389 filas, solo Parlasur) y 'TITULARES' son el mismo concepto
    CASE subcategoria_cargo
      WHEN 'TITULAR' THEN 'TITULARES'
      ELSE subcategoria_cargo
    END                                                        AS subcategoria,
    CASE WHEN posicion ~ '^\d+$' THEN posicion::int END        AS posicion,

    -- ----------------------------------------------------------- persona
    apellido,
    nombres,
    genero,
    dni,
    CASE WHEN fecha_nacimiento ~ '^\d{2}/\d{2}/\d{4}$'
         THEN to_date(fecha_nacimiento, 'DD/MM/YYYY') END      AS fecha_nacimiento,
    id_candidato
  FROM candidaturas
)

SELECT
  eleccion,
  etapa,
  fecha_eleccion,
  id_distrito,
  distrito,
  codigo_agrupacion,
  agrupacion,
  lista,
  cargo,
  subcategoria,
  posicion,
  apellido,
  nombres,
  genero,
  dni,
  fecha_nacimiento,
  id_candidato

FROM base;

-- Indices para los filtros mas frecuentes del portal.
CREATE INDEX idx_vc_eleccion      ON v_candidaturas (eleccion);
CREATE INDEX idx_vc_distrito      ON v_candidaturas (distrito);
CREATE INDEX idx_vc_cargo         ON v_candidaturas (cargo);
CREATE INDEX idx_vc_agrupacion    ON v_candidaturas (agrupacion);
CREATE INDEX idx_vc_apellido      ON v_candidaturas (apellido);
CREATE INDEX idx_vc_id_candidato  ON v_candidaturas (id_candidato);

COMMENT ON MATERIALIZED VIEW v_candidaturas IS
  'Capa semantica del portal. Una fila por candidatura: persona, cargo, lista '
  'y eleccion, 2011-2025. NO contiene resultados electorales: no sabe quien '
  'gano, cuantos votos obtuvo nadie, ni quien resulto electo.';
