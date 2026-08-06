-- ============================================================================
-- Capa semantica: candidaturas UEEDA 2011-2025  (Postgres / Supabase)
--
-- Es la unica superficie contra la que consulta el chat. El modelo no ve la
-- tabla cruda: ve esto, tipado y con nombres de dominio.
--
-- MATERIALIZADA a proposito. Como vista comun tardaba mas de dos minutos por
-- consulta: la subconsulta que arma el array de anomalias se ejecuta una vez
-- por fila. Los datos son estaticos, asi que se calcula una sola vez y queda
-- en disco. Son 38.907 filas, unos 8 MB.
--
--   Si se recargan los datos:  REFRESH MATERIALIZED VIEW v_candidaturas;
--
-- Las filas con anomalias NO se eliminan, se marcan. Un candidato que existio
-- sigue existiendo aunque su posicion este mal cargada.
--
--   Filas limpias:   WHERE cardinality(anomalias) = 0
--   Una anomalia:    WHERE 'sin_posicion' = ANY(anomalias)
--
-- Ejecutar despues de cargar los datos:
--   psql "$DATABASE_URL" -f pg_02_vista.sql
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
),

-- Estadisticas por lista: detectan numeracion incompleta.
-- `lista` es nula en el 24% de las filas (las generales hasta 2021 no tienen
-- listas internas). GROUP BY agrupa los nulos entre si, que es lo correcto.
lista_stats AS (
  SELECT
    id_instancia, id_distrito, agrupacion, lista, cargo, caracter,
    min(posicion)            AS pos_min,
    max(posicion)            AS pos_max,
    count(DISTINCT posicion) AS pos_distintas
  FROM base
  WHERE posicion IS NOT NULL
  GROUP BY 1,2,3,4,5,6
),

persona_stats AS (
  SELECT dni, count(DISTINCT genero) AS generos_distintos
  FROM base WHERE dni IS NOT NULL GROUP BY dni
),

persona_instancia_stats AS (
  SELECT id_instancia, dni, count(DISTINCT agrupacion) AS agrupaciones_distintas
  FROM base WHERE dni IS NOT NULL GROUP BY 1,2
),

marcado AS (
  SELECT
    b.*,

    -- A. Dos personas distintas en la misma posicion de la misma lista.
    --    15 grupos. Son listas internas paralelas cargadas con el mismo
    --    nombre de lista; ninguna columna del origen las separa.
    b.posicion IS NOT NULL
      AND count(*) OVER (
            PARTITION BY b.id_instancia, b.id_distrito, b.agrupacion,
                         b.lista, b.cargo, b.caracter, b.posicion
          ) > 1                                          AS anom_posicion_duplicada,

    -- B. Candidatura sin posicion. 64 de 75 son de PASO 2015.
    b.posicion IS NULL                                   AS anom_sin_posicion,

    -- C. La lista no arranca en 1, o le faltan numeros intermedios.
    coalesce(ls.pos_min <> 1 OR ls.pos_max <> ls.pos_distintas, false)
                                                         AS anom_lista_incompleta,

    -- D. Denominacion con parentesis sin cerrar o vacio. Error de texto.
    b.agrupacion ~ '\(\s*\)|\([^)]*$'                    AS anom_agrupacion_texto,

    -- E. Falta el codigo de agrupacion. 2021 esta 100% sin codigo y es un
    --    problema aparte; esto marca los 21 huecos aislados de otros anios.
    (b.codigo_agrupacion IS NULL AND b.anio <> 2021)     AS anom_sin_codigo_agrupacion,

    -- F. Identificador de persona faltante o invalido (6 DNI de un digito).
    (b.dni IS NULL OR length(b.dni) < 6
      OR b.id_candidato IS NULL OR b.apellido IS NULL)   AS anom_identificador_invalido,

    -- G. El mismo DNI dos veces en la misma lista y cargo.
    b.dni IS NOT NULL
      AND count(*) OVER (
            PARTITION BY b.id_instancia, b.id_distrito, b.agrupacion,
                         b.lista, b.cargo, b.caracter, b.dni
          ) > 1                                          AS anom_dni_repetido_en_lista,

    -- H. El mismo DNI en mas de una agrupacion en la misma instancia.
    --    Puede ser legitimo (cargos distintos) o un DNI mal cargado.
    coalesce(pi.agrupaciones_distintas, 0) > 1           AS anom_dni_en_varias_agrupaciones,

    -- I. El mismo DNI con genero distinto segun la eleccion. 29 DNI.
    --    Afecta cualquier calculo de paridad agrupado por persona.
    coalesce(p.generos_distintos, 0) > 1                 AS anom_genero_inconsistente,

    -- J. Edad imposible al momento de la eleccion.
    coalesce(
      b.anio - extract(YEAR FROM b.fecha_nacimiento) < 18
      OR b.anio - extract(YEAR FROM b.fecha_nacimiento) > 95,
      false)                                             AS anom_edad_imposible

  FROM base b
  LEFT JOIN lista_stats ls
    ON  b.id_instancia IS NOT DISTINCT FROM ls.id_instancia
    AND b.id_distrito  IS NOT DISTINCT FROM ls.id_distrito
    AND b.agrupacion   IS NOT DISTINCT FROM ls.agrupacion
    AND b.lista        IS NOT DISTINCT FROM ls.lista
    AND b.cargo        IS NOT DISTINCT FROM ls.cargo
    AND b.caracter     IS NOT DISTINCT FROM ls.caracter
  LEFT JOIN persona_stats p
    ON b.dni = p.dni
  LEFT JOIN persona_instancia_stats pi
    ON b.id_instancia = pi.id_instancia AND b.dni = pi.dni
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

  -- Anomalias detectadas en la fila. Array vacio = fila limpia.
  -- array_remove sobre un ARRAY literal es varios ordenes de magnitud mas
  -- rapido que una subconsulta correlacionada con unnest por fila.
  array_remove(ARRAY[
    CASE WHEN anom_posicion_duplicada         THEN 'posicion_duplicada'         END,
    CASE WHEN anom_sin_posicion               THEN 'sin_posicion'               END,
    CASE WHEN anom_lista_incompleta           THEN 'lista_incompleta'           END,
    CASE WHEN anom_agrupacion_texto           THEN 'agrupacion_texto_roto'      END,
    CASE WHEN anom_sin_codigo_agrupacion      THEN 'sin_codigo_agrupacion'      END,
    CASE WHEN anom_identificador_invalido     THEN 'identificador_invalido'     END,
    CASE WHEN anom_dni_repetido_en_lista      THEN 'dni_repetido_en_lista'      END,
    CASE WHEN anom_dni_en_varias_agrupaciones THEN 'dni_en_varias_agrupaciones' END,
    CASE WHEN anom_genero_inconsistente       THEN 'genero_inconsistente'       END,
    CASE WHEN anom_edad_imposible             THEN 'edad_imposible'             END
  ]::text[], NULL) AS anomalias

FROM marcado;

-- Indices para los filtros mas frecuentes del portal.
CREATE INDEX idx_vc_anio        ON v_candidaturas (anio);
CREATE INDEX idx_vc_distrito    ON v_candidaturas (distrito);
CREATE INDEX idx_vc_cargo       ON v_candidaturas (cargo);
CREATE INDEX idx_vc_agrupacion  ON v_candidaturas (agrupacion);
CREATE INDEX idx_vc_apellido    ON v_candidaturas (apellido);
CREATE INDEX idx_vc_anomalias   ON v_candidaturas USING gin (anomalias);

COMMENT ON MATERIALIZED VIEW v_candidaturas IS
  'Capa semantica del portal. Una fila por candidatura: persona, cargo, lista '
  'e instancia electoral, 2011-2025. La columna anomalias marca filas con '
  'problemas de calidad sin eliminarlas. NO contiene resultados electorales: '
  'no sabe quien gano, cuantos votos obtuvo nadie, ni quien resulto electo.';
