# Chat with data — portal conversacional sobre datos electorales

Portal donde cualquier persona puede preguntar en lenguaje natural sobre
candidaturas electorales argentinas (2011–2025) y recibe una respuesta
construida a partir de una consulta SQL sobre datos oficiales. 

Piloto: **[chatwithdata-phi.vercel.app](https://chatwithdata-phi.vercel.app)**.

Documentación completa:

- [`PROYECTO-chat-with-data.md`](./PROYECTO-chat-with-data.md) — qué es el
  proyecto, alcance, arquitectura, estado actual y roadmap.
- [`panel/README.md`](./panel/README.md) — cómo levantar la aplicación
  (`panel/`, Next.js) en local.
- [`panel/lib/context.ts`](./panel/lib/context.ts) — contexto del modelo
  (esquema, reglas de SQL, casos límite y diccionario de términos). Única
  fuente de verdad de cómo se traducen las preguntas a SQL.

## Estructura del repo

| Ruta | Qué es |
|---|---|
| `panel/` | Aplicación Next.js en producción: chat, validación de SQL, ejecución contra Postgres |
| `cargar_postgres.py` | Crea el esquema y carga la planilla UEEDA (`data/`) a Postgres |
| `pg_02_esquema.sql` | Esquema completo vigente: tabla cruda `candidaturas`, vista `v_candidaturas`, `consultas_log`, índices y permisos |
| `data/` | Planillas UEEDA de origen (fuera de git) |

Los datos son de publicación oficial de la UEEDA/CNE; el DNI y la fecha de
nacimiento de las candidaturas no requieren tratamiento especial (ver
`PROYECTO-chat-with-data.md`, sección 6.3).
