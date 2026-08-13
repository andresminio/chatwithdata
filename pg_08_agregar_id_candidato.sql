-- ============================================================================
-- Agrega id_candidato a v_candidaturas (Postgres / Supabase)
--
-- Bug: id_candidato ya se calculaba en la vista (CTE "base") pero se
-- quedaba afuera del SELECT final, así que nunca estuvo disponible para
-- consultar. Esto hacía que preguntas como "qué candidatos aparecen con
-- mayor frecuencia" se resolvieran agrupando por apellido+nombres, lo cual
-- mezcla personas distintas que comparten nombre y separa a la misma
-- persona si hay variantes de escritura entre elecciones.
--
-- Ejecutar en el SQL Editor de Supabase, después de pg_07_reordenar_log.sql.
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS v_candidaturas;

CREATE MATERIALIZED VIEW v_candidaturas AS

WITH base AS (
  SELECT
    -- ---------------------------------------------------------- instancia
    CASE WHEN eleccion ~ '^\d+$' THEN eleccion::int END        AS anio,
    CASE etapa
      WHEN '1' THEN 'PASO'
      WHEN '2' THEN 'Generales'
      WHEN '3' THEN 'Segunda vuelta'
    END                                                        AS etapa,
    label_eleccion                                             AS instancia,
    CASE WHEN fecha_eleccion ~ '^\d{2}/\d{2}/\d{4}$'
         THEN to_date(fecha_eleccion, 'DD/MM/YYYY') END        AS fecha_eleccion,
    id_eleccion                                                AS id_instancia,

    -- ------------------------------------------------------------- lugar
    CASE WHEN id_distrito ~ '^\d+$' THEN id_distrito::int END  AS id_distrito,
    distrito,
    tipo_eleccion                                              AS ambito,

    -- -------------------------------------------------------- agrupacion
    codigo_ap                                                  AS codigo_agrupacion,
    ap                                                         AS agrupacion,
    nombre_lista                                               AS lista,

    -- ------------------------------------------------------------- cargo
    cargo,
    CASE subcategoria_cargo
      WHEN 'TITULAR' THEN 'TITULARES'
      ELSE subcategoria_cargo
    END                                                        AS caracter,
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
  anio,
  etapa,
  instancia,
  fecha_eleccion,
  id_distrito,
  distrito,
  ambito,
  codigo_agrupacion,
  agrupacion,
  lista,
  cargo,
  caracter,
  posicion,
  apellido,
  nombres,
  genero,
  dni,
  fecha_nacimiento,
  id_candidato

FROM base;

-- Indices para los filtros mas frecuentes del portal.
CREATE INDEX idx_vc_anio          ON v_candidaturas (anio);
CREATE INDEX idx_vc_distrito      ON v_candidaturas (distrito);
CREATE INDEX idx_vc_cargo         ON v_candidaturas (cargo);
CREATE INDEX idx_vc_agrupacion    ON v_candidaturas (agrupacion);
CREATE INDEX idx_vc_apellido      ON v_candidaturas (apellido);
CREATE INDEX idx_vc_id_candidato  ON v_candidaturas (id_candidato);

COMMENT ON MATERIALIZED VIEW v_candidaturas IS
  'Capa semantica del portal. Una fila por candidatura: persona, cargo, lista '
  'e instancia electoral, 2011-2025. NO contiene resultados electorales: no '
  'sabe quien gano, cuantos votos obtuvo nadie, ni quien resulto electo.';
