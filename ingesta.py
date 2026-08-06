#!/usr/bin/env python3
"""
Ingesta de candidaturas UEEDA: xlsx -> Parquet -> GCS -> BigQuery.

    proyecto  oferta-electoral-raw
    bucket    gs://oferta-electoral-raw
    dataset   candidaturas_raw
    region    us-central1

Requisitos:
    pip install openpyxl pyarrow google-cloud-storage google-cloud-bigquery
    gcloud auth application-default login

Uso:
    python ingesta.py parquet     # 1. xlsx -> build/candidaturas.parquet
    python ingesta.py subir       # 2. parquet + xlsx original -> GCS
    python ingesta.py cargar      # 3. GCS -> BigQuery
    python ingesta.py todo        # los tres seguidos

    python ingesta.py cargar --ingest-date 2026-08-06   # recargar entrega vieja
"""

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from datetime import date, datetime, time, timezone
from pathlib import Path

# --------------------------------------------------------------------- CONFIG

PROYECTO = "oferta-electoral-raw"
BUCKET = "oferta-electoral-raw"
DATASET = "candidaturas_raw"
TABLA = "candidaturas"
REGION = "us-central1"  # bucket y dataset DEBEN coincidir en region

RAIZ = Path(__file__).resolve().parent
ARCHIVO = RAIZ / "data" / "UEEDA Precandidaturas y Candidaturas 2011 2025 v141025.xlsx"
HOJA = "Sheet1"
PARQUET = RAIZ / "build" / f"{TABLA}.parquet"

DESCRIPCION_TABLA = (
    "Precandidaturas (PASO) y candidaturas (generales y segunda vuelta) "
    "2011-2025. Una fila por persona, cargo, lista e instancia electoral. "
    "Capa cruda: espejo fiel del origen, todas las columnas STRING. "
    "No consultar desde aplicaciones; usar los modelos de dbt."
)

LINAJE = {
    "_archivo_origen": "Archivo .xlsx del que proviene la fila",
    "_fila_origen": "Numero de fila en la hoja original (1 = primera fila de datos)",
    "_md5_archivo": "MD5 del archivo origen, para detectar si cambio entre entregas",
    "_ingest_date": "Particion de la entrega en GCS (YYYY-MM-DD)",
    "_cargado_en": "Timestamp UTC de la conversion, ISO 8601",
}


def log(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


def hoy():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def md5(ruta):
    h = hashlib.md5()
    with open(ruta, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ------------------------------------------------------------- PASO 1: PARQUET

def normalizar(nombre):
    """'Subcategoria Cargo' -> 'subcategoria_cargo'. BigQuery solo acepta [a-z0-9_]."""
    s = unicodedata.normalize("NFKD", str(nombre)).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "_", s.lower().strip()).strip("_")
    return ("_" + s) if re.match(r"^[0-9]", s) else (s or "sin_nombre")


def a_texto(v):
    """
    Convierte una celda a str sin perder informacion.

    El caso que importa: 'Codigo AP' vale "047", con ceros a la izquierda. Si se
    lee con pandas o se pasa por CSV con autodeteccion, queda 47 y el dato se
    rompe en silencio. Por eso se lee celda por celda con openpyxl.
    """
    if v is None:
        return None
    if isinstance(v, str):
        return v.strip() or None
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return None
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, (datetime, date, time)):
        return v.isoformat()
    return str(v)


def paso_parquet(fecha):
    import openpyxl
    import pyarrow as pa
    import pyarrow.parquet as pq

    if not ARCHIVO.exists():
        raise SystemExit(f"No encuentro {ARCHIVO}")

    firma = md5(ARCHIVO)
    ahora = datetime.now(timezone.utc).isoformat()
    log(f"leyendo '{HOJA}' de {ARCHIVO.name}")

    wb = openpyxl.load_workbook(ARCHIVO, read_only=True, data_only=True)
    ws = wb[HOJA]
    filas = ws.iter_rows(values_only=True)

    encabezado = list(next(filas))
    while encabezado and encabezado[-1] in (None, ""):
        encabezado.pop()
    columnas = [normalizar(c) for c in encabezado]
    if len(set(columnas)) != len(columnas):
        raise SystemExit(f"Nombres de columna duplicados tras normalizar: {columnas}")
    ancho = len(columnas)

    datos = {c: [] for c in columnas}
    extra = {c: [] for c in LINAJE}

    for i, fila in enumerate(filas, start=1):
        vals = [a_texto(v) for v in fila[:ancho]]
        vals += [None] * (ancho - len(vals))
        if all(v is None for v in vals):
            continue
        for c, v in zip(columnas, vals):
            datos[c].append(v)
        extra["_archivo_origen"].append(ARCHIVO.name)
        extra["_fila_origen"].append(str(i))
        extra["_md5_archivo"].append(firma)
        extra["_ingest_date"].append(fecha)
        extra["_cargado_en"].append(ahora)

    wb.close()

    # Todo STRING a proposito: la capa cruda es un espejo del origen. El tipado
    # vive en dbt, versionado y con tests, no escondido en el script de carga.
    esquema = pa.schema([pa.field(c, pa.string()) for c in columnas + list(LINAJE)])
    tabla = pa.Table.from_pydict({**datos, **extra}, schema=esquema)

    PARQUET.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(tabla, PARQUET, compression="snappy")
    log(f"  {tabla.num_rows:,} filas x {len(columnas)} columnas -> {PARQUET.name} "
        f"({PARQUET.stat().st_size / 1024 / 1024:.1f} MB)")
    return tabla.num_rows


# ----------------------------------------------------------------- PASO 2: GCS

def ruta_parquet(fecha):
    return f"parquet/candidaturas/ingest_date={fecha}/{TABLA}.parquet"


def paso_subir(fecha, forzar=False):
    import pyarrow.parquet as pq
    from google.cloud import storage

    if not PARQUET.exists():
        raise SystemExit(f"Falta {PARQUET}. Corré primero: python ingesta.py parquet")

    bucket = storage.Client(project=PROYECTO).bucket(BUCKET)
    if not bucket.exists():
        raise SystemExit(f"El bucket gs://{BUCKET} no existe o no tenés permiso.")

    def subir(local, destino, content_type=None):
        blob = bucket.blob(destino)
        if blob.exists() and not forzar:
            log(f"  ya existe, se omite: {destino}")
            return
        log(f"  {local.name} ({local.stat().st_size / 1024 / 1024:.1f} MB) -> {destino}")
        blob.upload_from_filename(str(local), timeout=600, content_type=content_type)

    # El .xlsx original se guarda, no solo el Parquet. La planilla ya cambio una
    # vez (v150925 -> v141025) reordenando listas: sin una copia fechada del
    # original no se puede reconstruir de que version salio una respuesta.
    origen = f"origen/candidaturas/ingest_date={fecha}/{ARCHIVO.name}"
    subir(ARCHIVO, origen)
    subir(PARQUET, ruta_parquet(fecha))

    manifiesto = {
        "archivo_origen": ARCHIVO.name,
        "md5": md5(ARCHIVO),
        "bytes": ARCHIVO.stat().st_size,
        "hoja": HOJA,
        "filas": pq.read_metadata(PARQUET).num_rows,
        "ingest_date": fecha,
        "ingerido_en": datetime.now(timezone.utc).isoformat(),
        "tabla_destino": f"{PROYECTO}.{DATASET}.{TABLA}",
    }
    bucket.blob(
        f"origen/candidaturas/ingest_date={fecha}/_manifest.json"
    ).upload_from_string(
        json.dumps(manifiesto, ensure_ascii=False, indent=2),
        content_type="application/json",
    )
    log(f"  _manifest.json -> origen/candidaturas/ingest_date={fecha}/")
    log(f"  gs://{BUCKET}/{ruta_parquet(fecha)}")


# ------------------------------------------------------------ PASO 3: BIGQUERY

def paso_cargar(fecha):
    from google.cloud import bigquery

    cliente = bigquery.Client(project=PROYECTO, location=REGION)
    ref = f"{PROYECTO}.{DATASET}"
    try:
        ds = cliente.get_dataset(ref)
        if ds.location.lower() != REGION.lower():
            raise SystemExit(
                f"El dataset {ref} esta en {ds.location} y el bucket en {REGION}. "
                f"La carga cruzada de regiones falla: recrea el dataset en {REGION}."
            )
    except Exception as e:
        if "Not found" not in str(e):
            raise
        d = bigquery.Dataset(ref)
        d.location = REGION
        cliente.create_dataset(d)
        log(f"dataset creado: {ref} ({REGION})")

    uri = f"gs://{BUCKET}/{ruta_parquet(fecha)}"
    tabla_id = f"{ref}.{TABLA}"
    log(f"cargando {uri}")

    job = cliente.load_table_from_uri(
        uri,
        tabla_id,
        location=REGION,
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            # WRITE_TRUNCATE: la capa cruda refleja la ultima entrega completa.
            # El historico de entregas vive en GCS, particionado por ingest_date.
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        ),
    )
    job.result()

    tabla = cliente.get_table(tabla_id)
    tabla.description = DESCRIPCION_TABLA
    tabla.schema = [
        bigquery.SchemaField(
            f.name, f.field_type, mode=f.mode,
            description=LINAJE.get(f.name, f.description),
        )
        for f in tabla.schema
    ]
    cliente.update_table(tabla, ["description", "schema"])
    log(f"  {tabla.num_rows:,} filas x {len(tabla.schema)} columnas -> {tabla_id}")


# ---------------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paso", choices=["parquet", "subir", "cargar", "todo"])
    ap.add_argument("--ingest-date", default=None,
                    help="Particion a usar (YYYY-MM-DD). Por defecto, hoy UTC.")
    ap.add_argument("--forzar", action="store_true",
                    help="Reescribe objetos que ya existen en GCS")
    args = ap.parse_args()

    fecha = args.ingest_date or hoy()
    log(f"proyecto={PROYECTO} dataset={DATASET} region={REGION} ingest_date={fecha}")
    print()

    if args.paso in ("parquet", "todo"):
        paso_parquet(fecha)
    if args.paso in ("subir", "todo"):
        paso_subir(fecha, args.forzar)
    if args.paso in ("cargar", "todo"):
        paso_cargar(fecha)

    print()
    log("listo. Verificacion:")
    print(f"""    bq query --use_legacy_sql=false '
      SELECT COUNT(*) AS filas, COUNT(DISTINCT dni) AS personas,
             MIN(eleccion) AS desde, MAX(eleccion) AS hasta
      FROM `{PROYECTO}.{DATASET}.{TABLA}`'
""")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
