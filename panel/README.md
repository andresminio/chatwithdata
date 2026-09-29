# Panel — chat sobre candidaturas (en producción, en prueba)

Implementa el recorrido de una pregunta descrito en `PROYECTO-chat-with-data.md`
(4.3), con Gemini como modelo vía Vercel AI SDK.

## Arrancar

```bash
cd panel
rm -rf node_modules   # si ya existe una instalación parcial/rota
npm install
cp .env.local.example .env.local   # completar DATABASE_URL y GOOGLE_GENERATIVE_AI_API_KEY
npm run dev
```

Abrir `http://localhost:3000`.

## Variables de entorno

- `DATABASE_URL` — cadena del **session pooler** de Supabase, puerto 5432 (no la conexión directa, que es IPv6).
- `GOOGLE_GENERATIVE_AI_API_KEY` — de [Google AI Studio](https://aistudio.google.com/apikey).
- `GEMINI_MODELS` (opcional) — lista de modelos en orden de preferencia,
  separados por coma. Default: `gemini-3.5-flash-lite,gemini-3.6-flash`. Si un
  modelo responde 429/500/503 se reintenta 2 veces (5 s entre intentos) y
  después se rota al siguiente; si responde 404 se pasa directo al siguiente.
  Recién si fallan todos, la app muestra "En este momento el modelo de IA está
  experimentando alta demanda". Lógica en `lib/ia.ts`. (`GEMINI_MODEL`, la
  variable anterior, sigue funcionando: pone ese modelo primero en la lista.)
  Se eligió un "Lite" como primera opción a propósito: los Flash completos (3.6, 3.5, 2.5, 3)
  comparten el mismo límite gratuito de 5 RPM / 20 RPD, que dos llamadas por
  pregunta agotan en minutos; los "Flash Lite" de la línea 3.x dan 15 RPM /
  500 RPD. Pasar a un modelo de mayor poder de razonamiento (con plan pago)
  es parte del roadmap — ver "Pendiente" más abajo y la Etapa 4 de
  `PROYECTO-chat-with-data.md`.

## Estructura

| Archivo | Qué hace |
|---|---|
| `lib/context.ts` | Esquema de `v_candidaturas`, reglas de SQL, casos límite y diccionario de términos — se inyecta como contexto del modelo en cada llamada |
| `lib/sql-guard.ts` | Valida el SQL que devuelve el modelo antes de ejecutarlo: solo SELECT, solo `v_candidaturas`, sin DDL/DML, fuerza LIMIT. Es la solución definitiva, no un reemplazo temporal de `sqlglot` (que no corre en el runtime de Node/Vercel) |
| `lib/db.ts` | Ejecuta el SELECT validado en una transacción de solo lectura contra Postgres, con timeout |
| `lib/ia.ts` | Lista de modelos de Gemini y rotación cuando uno está saturado, sin cuota o no responde (2 intentos por modelo, 5 s entre intentos, 15 s máximo por intento). Todo tiene que terminar dentro del presupuesto de la pregunta, para no pasar los 60 s de Vercel |
| `lib/cache.ts` | Caché de respuestas completas en la tabla `respuestas_cache`, por pregunta normalizada y versión de los prompts. Las filas con `fijada = true` (las combinaciones de los chips, curadas a mano) se sirven siempre y no se invalidan ni se borran solas |
| `lib/respuesta.ts` | Prompt y llamada de redacción del resumen, y ejecución del SQL con su total — compartido por `/api/consulta` y `/api/redactar` |
| `app/api/consulta/route.ts` | Endpoint `POST /api/consulta`: caché → pregunta → SQL (Gemini) → validación → ejecución → prosa (Gemini). Registra cada paso en `consultas_log` |
| `app/api/redactar/route.ts` | Endpoint del botón "Reintentar resumen": vuelve a pedir solo la redacción de una consulta cuyo resumen falló. Lee pregunta y SQL de `consultas_log`, no del navegador |
| `app/api/reportar/route.ts` | Endpoint para marcar una respuesta puntual como reportada por el usuario |
| `app/page.tsx` | UI: input de pregunta (con dictado por voz), chips de filtro (Totales/Listado, distrito, género, cargo, etapa, año), tabla de resultados con descarga a Excel, SQL visible, recorrido guiado de onboarding (tour de pasos) y disclaimer de contenido generado por IA |

## Caché y respuestas curadas

Cada pregunta nueva cuesta dos llamadas a Gemini (traducción a SQL +
redacción). Como los datos no cambian entre cargas, una pregunta ya
respondida se guarda en la tabla `respuestas_cache` y la próxima vez se
devuelve completa (resumen, SQL, explicación y tabla) sin llamar a la IA.
Hay dos tipos de entradas, con reglas distintas:

| | Respuesta común | Respuesta curada (`fijada = true`) |
|---|---|---|
| Qué es | Cualquier pregunta que alguien hizo y salió bien | Las combinaciones de los chips de ejemplo, revisadas y editadas a mano |
| Cómo se crea | Sola, la primera vez que se responde bien | Se marca a mano (`UPDATE ... SET fijada = true`) |
| Si cambia un prompt (`context.ts` o el de redacción) | Deja de usarse: la próxima vez se genera de nuevo con el prompt nuevo | **Se sigue sirviendo igual** |
| Si se recargan los datos (`cargar_postgres.py`) | Se borra | **Se conserva**; el loader la lista para revisarla |
| Prioridad | — | Gana siempre sobre una común de la misma pregunta |

Nunca se guardan errores, respuestas "fuera de alcance" ni respuestas cuyo
resumen falló.

### Ejemplo: qué pasa con un chip

1. Alguien toca "Paridad de género" y después "Totales" → "Por distrito".
2. El panel arma el texto de la pregunta (la del chip más las instrucciones de
   los subchips) y lo manda a `/api/consulta`.
3. `lib/cache.ts` normaliza ese texto (minúsculas, sin espacios de más ni ¿?
   en los extremos) y busca:
   - primero una **fijada** con esa pregunta, sin importar la versión de los
     prompts;
   - si no hay, una **común** con esa pregunta y la versión actual de los
     prompts (la clave es un hash de pregunta + versión).
4. Si encuentra, responde al instante y registra la consulta en
   `consultas_log` con `alcance = 'ok_cache'`. Si no, sigue el recorrido
   normal con la IA y guarda el resultado como respuesta común.

### Combinaciones incoherentes de los chips

Algunos subchips contradicen la pregunta del chip: por ejemplo "Diputados
Nacionales 2025" + Listado → "Presidente y Vice", o cualquier chip de 2025 +
"PASO" (en 2025 no hubo PASO). Esas 13 combinaciones están en
`COMBINACIONES_INCOHERENTES` (`app/page.tsx`) y **nunca llegan a la API**: el
panel muestra una aclaración fija con dos párrafos (por qué no se puede, y
qué se muestra en su lugar), desmarca el subchip contradictorio y consulta la
versión coherente, que es una respuesta curada. Si se agrega un chip nuevo,
hay que revisar qué subchips lo contradicen y sumarlos ahí.

### Editar una respuesta curada

En Supabase: Table Editor → `respuestas_cache` → filtro `fijada = true`. O
con SQL:

```sql
-- Ver las curadas (las más usadas primero)
SELECT pregunta, respuesta, usos
FROM respuestas_cache
WHERE fijada
ORDER BY usos DESC;

-- Corregir el resumen de una
UPDATE respuestas_cache
SET respuesta = 'Texto corregido. Se puede usar **negrita** y listas con "- ".'
WHERE fijada
  AND pregunta = 'cuál es la edad promedio de los candidatos por cargo';
```

La columna `pregunta` está normalizada (minúsculas, sin ¿? en los extremos).
Editar solo `respuesta` y `explicacion_sql`: `filas` y `sql` tienen que seguir
coincidiendo entre sí y con la base, porque el SQL visible es lo que hace
auditable el dato.

### Curar una respuesta nueva

1. Hacer la pregunta en el panel (con los chips o escrita) hasta que la
   respuesta sea correcta: eso la guarda como común.
2. Marcarla como fijada:
   ```sql
   UPDATE respuestas_cache
   SET fijada = true
   WHERE pregunta = '...texto normalizado...';
   ```
3. Si hubiera más de una fijada para la misma pregunta, se sirve la más
   reciente.

### Después de cargar datos nuevos

`cargar_postgres.py` borra las respuestas comunes y conserva las curadas,
pero **no sabe si siguieron siendo correctas**: al terminar lista todas las
fijadas para revisarlas. Rehacerlas es un proceso manual y aparte: para cada
una que haya quedado desactualizada, borrarla
(`DELETE FROM respuestas_cache WHERE fijada AND pregunta = '...'`), volver a
hacer la pregunta en el panel y fijarla de nuevo.

## Pendiente

Según `PROYECTO-chat-with-data.md` (sección 7, Etapas 4 y 5), lo que sigue no
es "cerrar el piloto" — ya está en producción — sino estos frentes:

1. **Anti-abuso.** No hay Turnstile ni rate limiting propio; el único freno
   hoy es la cuota del proveedor del modelo, que no distingue tráfico
   legítimo de abuso.
2. **Modelo de mayor poder de razonamiento.** Hoy corre `gemini-3.5-flash-lite`
   por límite de cuota del free tier, no por elección de calidad. Requiere
   pasar a un plan pago.
3. **Rol de Postgres de solo lectura dedicado**, en vez de las credenciales
   completas del session pooler.
4. **Ampliación de alcance** (Etapa 5, más grande): sumar candidaturas desde
   1983 y vincular con la planilla de participación de agrupaciones políticas.

Ya resuelto: **caché de preguntas repetidas**, con respuestas curadas para
los chips de ejemplo — ver "Caché y respuestas curadas" más arriba.

Lo que **no** está en este roadmap, aunque lo previó una versión anterior del
proyecto: banco de evaluación formal y ejemplos resueltos (pregunta–SQL) en
el prompt. Se decidió saltearlos a propósito para llegar antes al resultado
funcional, y no se van a retomar salvo que se pida explícitamente.

## Mensajes de la interfaz

Catálogo no exhaustivo de los textos fijos más relevantes — para el texto
exacto de los chips de filtro, los pasos del tour de onboarding y los
ejemplos de pregunta, `app/page.tsx` es la fuente de verdad (cambian con
frecuencia; catalogarlos acá se desactualiza rápido).

### Textos fijos principales

| Elemento | Texto |
|---|---|
| Badge | "Asistente IA" |
| Título | "Chateá con los datos electorales" |
| Descripción | "Accedé a información sobre precandidaturas y candidaturas electorales nacionales de 2011 a 2025 mediante lenguaje natural." |
| Placeholder del buscador | "¿Qué te gustaría saber sobre las candidaturas?" |
| Botón | "Preguntar" — mientras espera respuesta, el botón/input se ocultan y aparece un overlay animado con el texto "Pensando" |
| Botón de voz | "Preguntar por voz" / "Detener dictado" mientras escucha |
| Título del desplegable SQL | "Consulta realizada por la IA" |
| Botón de descarga | "Descargar Excel" (genera un `.xlsx` real, no CSV) |
| Disclaimer bajo cada respuesta | "Contenido generado con inteligencia artificial. Verificá la información importante antes de utilizarla." |
| Recorrido guiado | Tour de onboarding de varios pasos con spotlight sobre la pantalla real, para primera visita |

### Mensajes generados por la IA (varían según la consulta)

- **Respuesta normal**: la redacta la IA en base a las filas devueltas.
- **Pregunta fuera de alcance** (pide resultados electorales, votos, quién
  ganó, etc.): la IA redacta la explicación del límite; si no lo genera, cae
  en un texto por defecto fijo en el endpoint.

### Mensajes de error fijos (casos técnicos)

Body inválido, falla de traducción a SQL, SQL rechazado por el validador y
falla de ejecución contra la base **comparten hoy el mismo mensaje genérico**
("Ups, no pudimos procesar esta consulta. Probá reformularla."), cada uno con
su propio código HTTP y un `logId` para poder correlacionar el caso en
`consultas_log` si hace falta investigar.

| Escenario | Mensaje |
|---|---|
| Body inválido / falla traducción a SQL / SQL rechazado / falla ejecución | "Ups, no pudimos procesar esta consulta. Probá reformularla." (con `logId`) |
| Sin pregunta | "Escribí una pregunta para poder ayudarte." |
| Se agotó la cuota gratuita de la IA | "Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en unos [N] segundos / en un minuto." — con botón "Reintentar" |
| IA saturada: fallaron todos los modelos de la lista al traducir a SQL | "En este momento el modelo de IA está experimentando alta demanda. Probá de nuevo más tarde." — con botón "Reintentar" |
| Falla la redacción del resumen, pero sí hay datos | "No pudimos generar el resumen porque la IA está con alta demanda en este momento. Los resultados de tu consulta están en la tabla de abajo." (o la variante por cuota / genérica) — con botón "Reintentar resumen" |
| Falla la conexión desde el navegador (fetch) | "No pudimos conectarnos con el servicio. Verificá tu conexión e intentá nuevamente." |
