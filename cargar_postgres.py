#!/usr/bin/env python3
"""
Carga candidaturas en Postgres (Supabase).

Lee el Excel, lo convierte a texto celda por celda y lo inserta con COPY.
Un solo paso: no hay archivo intermedio en disco.

Requisitos:
    pip install openpyxl "psycopg[binary]"

La cadena de conexion se lee de la variable de entorno DATABASE_URL. Usar la
del SESSION POOLER (puerto 5432): la conexion directa de Supabase es IPv6 y no
resuelve desde una red IPv4.

    Windows (PowerShell):
        $env:DATABASE_URL="postgresql://postgres.uywxcspzavewdyvuvcot:TU-PASSWORD@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"
    Linux / macOS:
        export DATABASE_URL="postgresql://..."

Uso:
    python cargar_postgres.py           # crea tabla, carga, crea vista
    python cargar_postgres.py --solo-datos
"""

import argparse
import os
import sys
from datetime import date, datetime, time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
ARCHIVO = RAIZ / "data" / "UEEDA Precandidaturas y Candidaturas 2011 2025 v141025.xlsx"
HOJA = "Sheet1"
TABLA = "candidaturas"
SQL_TABLA = RAIZ / "pg_01_tabla.sql"
SQL_VISTA = RAIZ / "pg_02_vista.sql"

COLUMNAS = [
    "eleccion", "etapa", "id_eleccion", "label_eleccion", "fecha_eleccion",
    "id_distrito", "distrito", "tipo_eleccion", "codigo_ap", "ap",
    "nombre_lista", "cargo", "subcategoria_cargo", "posicion", "id_candidato",
    "genero", "dni", "apellido", "nombres", "candidatura", "fecha_nacimiento",
]


def log(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


def a_texto(v):
    """
    Convierte una celda a str sin perder informacion.

    El caso que importa: 'Codigo AP' vale "047", con ceros a la izquierda. Si se
    lee con pandas o se pasa por CSV con autodeteccion de tipos, queda 47 y el
    dato se rompe en silencio. Por eso se lee celda por celda con openpyxl.
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


def leer_excel():
    import openpyxl

    if not ARCHIVO.exists():
        raise SystemExit(f"No encuentro {ARCHIVO}")

    log(f"leyendo '{HOJA}' de {ARCHIVO.name}")
    wb = openpyxl.load_workbook(ARCHIVO, read_only=True, data_only=True)
    filas = wb[HOJA].iter_rows(values_only=True)
    next(filas)  # descarta el encabezado

    n = len(COLUMNAS)
    datos = []
    for fila in filas:
        vals = [a_texto(v) for v in fila[:n]]
        vals += [None] * (n - len(vals))
        if all(v is None for v in vals):
            continue
        datos.append(vals)
    wb.close()
    log(f"  {len(datos):,} filas x {n} columnas")
    return datos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--solo-datos", action="store_true",
                    help="No ejecuta pg_01_tabla.sql ni pg_02_vista.sql")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit(
            "Falta DATABASE_URL. Ver el encabezado de este archivo.\n"
            "Usar la cadena del SESSION POOLER (puerto 5432), no la directa."
        )

    try:
        import psycopg
    except ImportError:
        raise SystemExit('Falta la libreria. Instalar con:\n    pip install "psycopg[binary]"')

    datos = leer_excel()

    with psycopg.connect(url) as con:
        with con.cursor() as cur:
            if not args.solo_datos:
                log("creando tabla")
                cur.execute(SQL_TABLA.read_text(encoding="utf-8"))
            else:
                cur.execute(f"TRUNCATE {TABLA} CASCADE")

            log("copiando datos")
            # write_row y no un CSV armado a mano: psycopg serializa None como
            # NULL de Postgres sin ambiguedad. Con CSV, un marcador de NULL
            # entrecomillado entra como el texto literal '\N', y entonces
            # `dni IS NULL` no se cumple nunca y las banderas de calidad que
            # dependen de nulos quedan mal.
            copia = f"COPY {TABLA} ({', '.join(COLUMNAS)}) FROM STDIN"
            with cur.copy(copia) as cp:
                for fila in datos:
                    cp.write_row(fila)

            cur.execute(f"SELECT count(*) FROM {TABLA}")
            log(f"  {cur.fetchone()[0]:,} filas en {TABLA}")

            if not args.solo_datos:
                log("creando vista")
                cur.execute(SQL_VISTA.read_text(encoding="utf-8"))

            cur.execute("""
                SELECT count(*) AS filas,
                       count(*) FILTER (WHERE cardinality(anomalias) = 0) AS limpias
                FROM v_candidaturas
            """)
            filas, limpias = cur.fetchone()
            log(f"  v_candidaturas: {filas:,} filas, {limpias:,} sin anomalias "
                f"({limpias / filas * 100:.1f}%)")
        con.commit()

    log("listo")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
