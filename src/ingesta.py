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
    python ingesta.py parquet     # xlsx -> build/candidaturas.parquet
    python ingesta.py subir       # -> gs://oferta-electoral-raw/candidaturas.parquet
    python ingesta.py cargar      # -> BigQuery
    python ingesta.py todo
"""

import argparse
import re
import unicodedata
from datetime import date, datetime, time
from pathlib import Path

PROYECTO = "oferta-electoral-raw"
BUCKET = "oferta-electoral-raw"
DATASET = "candidaturas_raw"
TABLA = "candidaturas"
REGION = "us-central1"  # bucket y dataset DEBEN coincidir

RAIZ = Path(__file__).resolve().parent
ARCHIVO = RAIZ / "data" / "UEEDA Precandidaturas y Candidaturas 2011 2025 v141025.xlsx"
HOJA = "Sheet1"
PARQUET = RAIZ / "build" / f"{TABLA}.parquet"
BLOB = f"{TABLA}.parquet"


def log(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


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


def paso_parquet():
    import openpyxl
    import pyarrow as pa
    import pyarrow.parquet as pq

    if not ARCHIVO.exists():
        raise SystemExit(f"No encuentro {ARCHIVO}")

    log(f"leyendo '{HOJA}' de {ARCHIVO.name}")
    wb = openpyxl.load_workbook(ARCHIVO, read_only=True, data_only=True)
    filas = wb[HOJA].iter_rows(values_only=True)

    encabezado = list(next(filas))
    while encabezado and encabezado[-1] in (None, ""):
        encabezado.pop()
    columnas = [normalizar(c) for c in encabezado]
    if len(set(columnas)) != len(columnas):
        raise SystemExit(f"Columnas duplicadas tras normalizar: {columnas}")
    ancho = len(columnas)

    datos = {c: [] for c in columnas}
    for fila in filas:
        vals = [a_texto(v) for v in fila[:ancho]]
        vals += [None] * (ancho - len(vals))
        if all(v is None for v in vals):
            continue
        for c, v in zip(columnas, vals):
            datos[c].append(v)
    wb.close()

    # Todo STRING a proposito: la capa cruda es un espejo del origen.
    # El tipado vive en dbt, versionado y con tests.
    esquema = pa.schema([pa.field(c, pa.string()) for c in columnas])
    tabla = pa.Table.from_pydict(datos, schema=esquema)

    PARQUET.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(tabla, PARQUET, compression="snappy")
    log(f"  {tabla.num_rows:,} filas x {tabla.num_columns} columnas -> {PARQUET.name} "
        f"({PARQUET.stat().st_size / 1024 / 1024:.1f} MB)")


def paso_subir():
    from google.cloud import storage

    if not PARQUET.exists():
        raise SystemExit(f"Falta {PARQUET}. Corré: python ingesta.py parquet")

    bucket = storage.Client(project=PROYECTO).bucket(BUCKET)
    log(f"subiendo {PARQUET.name} -> gs://{BUCKET}/{BLOB}")
    bucket.blob(BLOB).upload_from_filename(str(PARQUET), timeout=600)


def paso_cargar():
    from google.cloud import bigquery

    cliente = bigquery.Client(project=PROYECTO, location=REGION)
    tabla_id = f"{PROYECTO}.{DATASET}.{TABLA}"
    uri = f"gs://{BUCKET}/{BLOB}"

    log(f"cargando {uri}")
    cliente.load_table_from_uri(
        uri,
        tabla_id,
        location=REGION,
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        ),
    ).result()

    tabla = cliente.get_table(tabla_id)
    log(f"  {tabla.num_rows:,} filas x {len(tabla.schema)} columnas -> {tabla_id}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paso", choices=["parquet", "subir", "cargar", "todo"])
    args = ap.parse_args()

    if args.paso in ("parquet", "todo"):
        paso_parquet()
    if args.paso in ("subir", "todo"):
        paso_subir()
    if args.paso in ("cargar", "todo"):
        paso_cargar()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
