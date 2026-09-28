-- ============================================================================
-- Esquema completo de chatwithdata (Postgres / Supabase)
--
-- Reemplaza a pg_01_tabla.sql + pg_08_agregar_id_candidato.sql. Reproduce el
-- esquema vigente en producción (exportado de Supabase el 2026-09-28):
--
--   candidaturas     capa cruda, todas las columnas texto (espejo del Excel)
--   v_candidaturas   capa semántica (vista materializada) que consulta el panel
--   consultas_log    historial de preguntas del panel
--   respuestas_cache respuestas ya calculadas, para no volver a llamar a la IA
--
-- Se puede volver a correr: recrea candidaturas y v_candidaturas desde cero,
-- pero NO toca consultas_log si ya existe (conserva el historial).
--
-- La vista se crea vacía; cargar_postgres.py la refresca después de copiar
-- los datos. Si se corre a mano:
--   psql "$DATABASE_URL" -f pg_02_esquema.sql
--   python cargar_postgres.py --solo-datos
-- ============================================================================

DROP MATERIALIZED VIEW IF EXISTS v_candidaturas;
DROP TABLE IF EXISTS candidaturas;


-- ----------------------------------------------------------------------------
-- Capa cruda
--
-- Todas las columnas TEXT a propósito: espejo fiel de la planilla. El tipado
-- vive en la vista, donde se puede leer y corregir, no escondido en la carga.
-- ----------------------------------------------------------------------------

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
  'Origen: UEEDA Precandidaturas y Candidaturas 2011 2025 v100826.xlsx, Sheet1. '
  'No consultar desde la aplicacion: usar la vista v_candidaturas.';


-- ----------------------------------------------------------------------------
-- Capa semántica
--
-- Los nombres de columna son los que usa panel/lib/context.ts (eleccion,
-- subcategoria, ...). Si se cambia alguno acá, hay que cambiarlo también en
-- el contexto del modelo.
-- ----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW v_candidaturas AS

WITH base AS (
  SELECT
    -- ---------------------------------------------------------- instancia
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
    codigo_ap                                                  AS codigo_agrupacion,
    ap                                                         AS agrupacion,
    nombre_lista                                               AS lista,

    -- ------------------------------------------------------------- cargo
    cargo,
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
FROM base

WITH NO DATA;

-- Índices para los filtros más frecuentes del portal.
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


-- ----------------------------------------------------------------------------
-- Historial de consultas del panel
--
-- IF NOT EXISTS: correr este archivo de nuevo no borra el historial.
-- (En producción la secuencia y la PK conservan el sufijo "_nueva" de una
-- migración vieja; es solo el nombre, la estructura es la misma.)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consultas_log (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  creado             timestamptz NOT NULL DEFAULT now(),
  pregunta           text        NOT NULL,
  sql                text,
  alcance            text        NOT NULL,  -- ok | fuera_de_alcance | error_* (ver panel/lib/db.ts)
  total_registros    integer,
  filas_devueltas    integer,
  truncado           boolean     NOT NULL DEFAULT false,
  error              text,
  reportado_usuario  boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_consultas_log_alcance
  ON consultas_log (alcance);
CREATE INDEX IF NOT EXISTS idx_consultas_log_creado
  ON consultas_log (creado);
CREATE INDEX IF NOT EXISTS idx_consultas_log_reportado_usuario
  ON consultas_log (reportado_usuario)
  WHERE reportado_usuario = true;

COMMENT ON TABLE consultas_log IS
  'Historial de preguntas hechas al panel de chat, con el SQL generado y el '
  'resultado de cada paso. Anónimo: no guarda quién preguntó.';


-- ----------------------------------------------------------------------------
-- Caché de respuestas del panel (ver panel/lib/cache.ts)
--
-- Una fila por pregunta normalizada + versión de los prompts. Se vacía al
-- recargar los datos (cargar_postgres.py). IF NOT EXISTS: correr este archivo
-- de nuevo no la borra; se recrea vacía solo si no existía.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS respuestas_cache (
  clave            text        PRIMARY KEY,  -- sha256(version + pregunta normalizada)
  version          text        NOT NULL,     -- hash de los prompts vigentes al guardarla
  pregunta         text        NOT NULL,     -- pregunta normalizada, para poder leerla
  respuesta        text        NOT NULL,
  sql              text        NOT NULL,
  explicacion_sql  text,
  filas            json        NOT NULL,  -- json y no jsonb: jsonb reordena las claves y
                                            -- el panel arma las columnas con ese orden
  total            integer,
  truncado         boolean     NOT NULL,
  limite           integer     NOT NULL,
  creado           timestamptz NOT NULL DEFAULT now(),
  usos             integer     NOT NULL DEFAULT 0,  -- veces que se sirvió desde la caché
  ultimo_uso       timestamptz
);

COMMENT ON TABLE respuestas_cache IS
  'Respuestas completas ya calculadas por el panel, por pregunta normalizada y '
  'version de los prompts. Se vacia al recargar los datos.';


-- ----------------------------------------------------------------------------
-- Seguridad (API pública de Supabase)
--
-- La app se conecta como postgres por el session pooler y no depende de nada
-- de esto. Lo que se cierra es la Data API de Supabase (roles anon y
-- authenticated), que Supabase habilita por defecto en el esquema public:
--
--   - Tablas: RLS activada y sin políticas => la API no ve ni escribe filas.
--   - Vista materializada: no admite RLS, así que se le quitan los permisos a
--     anon y authenticated (Supabase se los da por defecto al crearla).
-- ----------------------------------------------------------------------------

ALTER TABLE candidaturas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultas_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE respuestas_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON v_candidaturas FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON v_candidaturas FROM authenticated;
  END IF;
END
$$;
