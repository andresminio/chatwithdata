# chatwithdata — portal conversacional sobre datos electorales (UEEDA / CNE)

Portal donde cualquier persona puede preguntar en lenguaje natural sobre
candidaturas electorales argentinas (2011–2025) y recibe una respuesta
construida a partir de una consulta SQL real sobre los datos oficiales de la
UEEDA. En producción, en etapa de prueba: **[chatwithdata-phi.vercel.app](https://chatwithdata-phi.vercel.app)**.

Documentación completa:

- [`PROYECTO-chat-with-data.md`](./PROYECTO-chat-with-data.md) — qué es el
  proyecto, alcance, arquitectura, estado actual y roadmap.
- [`panel/README.md`](./panel/README.md) — cómo levantar la aplicación
  (`panel/`, Next.js) en local.
- [`diccionario_terminos.md`](./diccionario_terminos.md) — sinónimos, siglas
  y nombres coloquiales usados para traducir preguntas a SQL.

## Estructura del repo

| Ruta | Qué es |
|---|---|
| `panel/` | Aplicación Next.js en producción: chat, validación de SQL, ejecución contra Postgres |
| `cargar_postgres.py` | Carga las planillas UEEDA (`data/`) a Postgres |
| `pg_01_tabla.sql` | DDL de la tabla cruda `candidaturas` |
| `pg_08_agregar_id_candidato.sql` | DDL vigente de la vista semántica `v_candidaturas` |
| `diccionario_terminos.md` | Diccionario de términos del dominio electoral |
| `data/` | Planillas UEEDA de origen (fuera de git) |

Los datos son de publicación oficial de la UEEDA/CNE; el DNI y la fecha de
nacimiento de las candidaturas no requieren tratamiento especial (ver
`PROYECTO-chat-with-data.md`, sección 6.3).
