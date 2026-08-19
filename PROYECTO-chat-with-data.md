# Proyecto: Portal conversacional sobre datos electorales — UEEDA / CNE

Documento de contexto. Refleja el estado real del proyecto, no el plan original.
Última revisión: 19 de agosto de 2026.

---

## 1. Qué es

Un portal donde cualquier persona puede preguntar en lenguaje natural sobre
candidaturas electorales argentinas y recibe una respuesta construida a partir
de una consulta SQL real sobre los datos oficiales de la UEEDA.

No es un buscador ni un tablero. La diferencia con Looker Studio —que ya cubre
la visualización— es que acá el usuario no necesita saber qué tablero abrir ni
cómo filtrarlo. Formula la pregunta como la piensa.

**Principio rector:** cada cifra que el portal muestre debe provenir de una
consulta ejecutada y auditable. El modelo de lenguaje traduce e interpreta;
nunca calcula ni recuerda datos.

---

## 2. Estado actual

**En producción, en etapa de prueba.** El panel (`panel/`) está desplegado y
funcionando contra datos reales. No se llegó a esta etapa por el camino
original: se decidió saltear el banco de evaluación formal y los ejemplos
resueltos de la Etapa 1 para llegar antes al resultado funcional (ver
sección 7).

| Pieza | Estado |
|---|---|
| Datos en Postgres | Hecho |
| Capa semántica (`v_candidaturas`) | Hecha — tipada, con índices para los filtros más frecuentes |
| Diccionario de términos | Hecho — `diccionario_terminos.md`, traducido a prompt en `panel/lib/context.ts` |
| Banco de evaluación formal | No se hizo — se saltó a propósito para priorizar el resultado funcional |
| Ejemplos resueltos (pregunta–SQL) en el prompt | No se hizo — mismo motivo |
| Aplicación de chat | Hecha y en producción (`panel/`, Next.js) |
| Participación de agrupaciones políticas | Fuera de alcance actual — ver sección 7 |
| Candidaturas anteriores a 2011 | Fuera de alcance actual — ver sección 7 |

---

## 3. Alcance

### 3.1 Dominio incluido

**Precandidaturas y candidaturas, 2011–2025.** Personas que se presentaron en
cada instancia electoral: PASO, generales y segunda vuelta. Por cargo, distrito,
agrupación, nombre de lista, posición en la lista, carácter de titular o
suplente, y género.

*(El rango 2011–2025 es el alcance actual, no un límite del dominio: sumar
candidaturas desde 1983 es parte del roadmap — ver sección 7.)*

### 3.2 Dimensiones

- **Distrito** — 24 distritos electorales más el ámbito nacional (Distrito Único).
- **Categoría de cargo** — Presidente y Vice, Senadores Nacionales, Diputados
  Nacionales, Parlamentarios del Mercosur.
- **Etapa** — PASO, Generales, Segunda Vuelta.
- **Año electoral** — 2011, 2013, 2015, 2017, 2019, 2021, 2023, 2025.

### 3.3 Qué preguntas responde

- Quiénes se postularon, a qué cargo, por qué agrupación y en qué posición.
- Paridad de género en las listas, por distrito, cargo y elección.
- Trayectoria de una persona a lo largo de varias elecciones (por `id_candidato`).
- Composición de una lista concreta.
- Comparaciones entre elecciones, entre distritos y entre agrupaciones.
- Agregados: cantidad de candidaturas por elección, por distrito, por cargo.

### 3.4 Qué NO responde — límite explícito

**El sistema no tiene resultados electorales.** No sabe quién ganó, cuántos votos
obtuvo nadie, ni quién resultó electo. Tampoco tiene padrón, afiliaciones,
autoridades de mesa, escrutinios ni financiamiento.

Esto no es un detalle operativo: *"¿quién ganó en 2023?"* es una de las
preguntas más frecuentes del portal. El sistema reconoce esa pregunta, explica
que trabaja sobre candidaturas y no sobre resultados, y no inventa una
respuesta. Responder algo plausible ante una pregunta fuera de alcance es el
peor modo de falla posible para un organismo electoral.

Tratar "no puedo responder eso" como una respuesta exitosa —y no como una
falla— sigue siendo un requisito de diseño.

**Tampoco responde sobre partidos ni alianzas.** Qué partidos integraron cada
alianza, qué partidos estaban vigentes en cada elección y quién superó las PASO
son datos que viven en la planilla de participación, que hoy está fuera de
alcance. Vincular ambas fuentes es parte del roadmap (sección 7).

### 3.5 Casos límite que el portal debe reconocer

No son huecos de datos: son hechos del calendario electoral. Una respuesta vacía
sería incorrecta; hay que explicar por qué no hay datos.

- **No hubo PASO en 2025.** Ese año tiene solo generales.
- **Parlamentarios del Mercosur solo existen en 2015 y 2023.**
- **Presidente y Vice solo en 2011, 2015, 2019 y 2023.**
- **Segunda vuelta solo en 2015 y 2023.**

---

## 4. Arquitectura

```
data/*.xlsx  (planillas UEEDA)
   ↓  cargar_postgres.py      lee celda por celda, todo como texto
Postgres / Supabase  ·  tabla candidaturas       capa cruda
   ↓  pg_02...pg_08 (histórico) → hoy: pg_01_tabla.sql + pg_08_agregar_id_candidato.sql
Postgres  ·  v_candidaturas (materializada)      capa semántica
   ↓
panel/ (Next.js, Vercel)  ──→  Portal público
```

### 4.1 Por qué no hay BigQuery ni dbt

El plan original tenía BigQuery como almacén, dbt para transformar y Postgres
como capa de servicio. Se descartó, y conviene dejar escrito por qué:

- **BigQuery** se justificaba por dos razones: ser la fuente única compartida con
  Looker Studio, y escalar a resultados por mesa. Ninguna aplica: no existe un
  almacén institucional de la CNE al que conectarse, y el volumen actual lo
  resuelve Postgres en milisegundos.
- **dbt** resuelve dependencias entre modelos encadenados. Con una sola tabla de
  origen y sin uniones que resolver, no hay dependencias. Recupera sentido cuando
  se incorpore participación (sección 7).

Se llegó a cargar todo en BigQuery antes de tomar esta decisión. El costo fue una
tarde; el camino queda hecho por si aparece un almacén institucional.

### 4.2 Herramientas (lo que realmente corre hoy)

| Función | Herramienta | Nota |
|---|---|---|
| Base de datos | **Supabase** (Postgres) | Conexión directa por el **session pooler** (puerto 5432), no el pooler transaccional ni la conexión directa IPv6 |
| Carga | **openpyxl + psycopg** | Lee el Excel sin destruir los datos (ver 5.1) |
| Capa semántica | **Vista materializada** (`v_candidaturas`) | Los datos son estáticos: se calcula una vez, se refresca con `REFRESH MATERIALIZED VIEW` |
| Aplicación | **Next.js 15 (App Router)** | Interfaz de chat, tabla de resultados, SQL visible |
| Capa de modelo | **Vercel AI SDK + Gemini** | Modelo detrás de la variable `GEMINI_MODEL`; hoy `gemini-3.5-flash-lite` por cuota de free tier, no por elección de calidad — ver sección 7, roadmap |
| Validación de SQL | **`lib/sql-guard.ts`**, validador por reglas explícitas | El documento original preveía `sqlglot`; se descartó porque es una librería Python y no corre en el runtime de Node/Vercel. No es un parcho temporal: es la solución vigente |
| Hosting | **Vercel** | En producción |
| Anti-abuso | *(sin implementar)* | No hay Turnstile ni rate limiting propio todavía; el único control de tráfico hoy es el límite de cuota del propio proveedor del modelo. Ver sección 8 |

Criterio de selección: **ningún componente obliga a reescribir para pasar a
producción.** El único sin sustituto directo es el modelo, y por eso está detrás
de una capa de abstracción (una variable de entorno).

### 4.3 Recorrido de una pregunta

**El SQL se ejecuta en Postgres. El modelo de lenguaje nunca toca los datos:
traduce la pregunta a SQL y después redacta a partir de las filas que Postgres
ya devolvió.**

```
Navegador                Servidor (Next.js en Vercel)              Servicios
─────────                ────────────────────────────              ─────────

"¿cuántas mujeres
 encabezaron listas  ──→  1. recibe la pregunta
 en Córdoba 2023?"

                          2. arma el prompt:
                             pregunta + esquema de v_candidaturas
                             + diccionario de términos    ────────→  LLM
                                                          ←──────────  devuelve
                                                                       SOLO texto SQL

                          3. valida el SQL (sql-guard.ts):
                             ¿es SELECT? ¿solo v_candidaturas?
                             ¿tiene LIMIT? → si no, rechaza

                          4. EJECUTA el SQL          ───────────────→  Postgres
                             (transacción READ ONLY,                   (Supabase)
                              statement_timeout)       ←───────────────  filas

                          5. manda esas filas al LLM
                             para redactar             ──────────────→  LLM
                                                       ←──────────────  prosa

  respuesta +         ←──  6. devuelve prosa + tabla + el SQL ejecutado
  tabla + SQL              (y registra la consulta en consultas_log)
```

**Dónde corre cada cosa.** Todos los pasos son la aplicación Next.js, del lado
del servidor. El navegador solo muestra. El cálculo ocurre íntegramente en
Postgres, en el paso 4.

**El modelo se invoca dos veces y nunca calcula.** La primera vez recibe el
esquema, no datos. La segunda recibe únicamente las filas que devolvió Postgres.
Si el modelo inventa una cifra, se introduce en el paso 5 — y por eso la tabla
va visible junto a la respuesta: el desvío queda a la vista.

**El navegador nunca habla con Postgres.** La cadena de conexión vive solo en el
servidor (`panel/lib/db.ts`). Si el navegador consultara directo, las
credenciales quedarían expuestas en el código de la página.

**No hay rol de Postgres de solo lectura dedicado.** La app usa las
credenciales completas del `postgres` del session pooler; la única defensa hoy
es `sql-guard.ts` (paso 3) más `BEGIN TRANSACTION READ ONLY` a nivel de sesión
SQL (paso 4). Es una brecha conocida, no un olvido — ver sección 9.

**Cada pregunta queda registrada** en `consultas_log`: la pregunta, el SQL
generado, qué pasó (ok / fuera de alcance / algún tipo de error) y cuántas
filas devolvió. Es anónimo por diseño — no hay login en el panel.

**El paso 5 envía datos al proveedor del modelo** — las filas del resultado, no
la base. Con datos públicos no representa un problema, pero es el punto a
revisar si alguna vez entra información que no lo sea.

### 4.4 La capa semántica

Es el activo técnico central del proyecto y lo que determina la tasa de acierto.

**`v_candidaturas`** — el modelo nunca ve la tabla cruda. Ve una vista
materializada, tipada y con nombres en lenguaje del dominio, más un
`id_candidato` estable para poder seguir a una persona entre elecciones sin
depender de apellido + nombres (que se repite y varía en escritura). La
traducción a SQL falla sobre todo al resolver uniones entre tablas; acá no hay
ninguna que resolver.

**Diccionario de términos** (`diccionario_terminos.md`) — sinónimos, siglas y
nombres coloquiales: "CABA" y "Capital Federal", "diputados" y "Diputados
Nacionales", "Parlasur", "las PASO", "LLA". Se armó a partir de los valores
reales del Excel de origen, no de supuestos. Se inyecta en el prompt vía
`panel/lib/context.ts` — si el diccionario cambia, hay que actualizar ese
archivo a mano, no está automatizado.

**Regla de dominio: nunca fusionar agrupaciones por nombre.** Cada grafía de
`agrupacion` (p. ej. las más de 30 variantes de "Cambiemos" o de "Frente de
Izquierda") es una entidad legalmente distinta según distrito y elección.
Ningún término del diccionario mapea una sigla o nombre coloquial a un valor
exacto de `agrupacion`: siempre se traduce a un patrón `ILIKE '%...%'`, y el
resultado siempre muestra la columna `agrupacion` real para que un match de
más quede a la vista.

**Ejemplos resueltos (pregunta–SQL) en el prompt** — no se implementaron. Se
había previsto como parte de la Etapa 1 para cubrir patrones típicos (filtro
temporal, comparación entre elecciones, agregación por distrito, conteo por
género), pero se saltearon a propósito para llegar antes al prototipo
funcional. No están en el roadmap actual salvo que la calidad de traducción a
SQL lo justifique.

---

## 5. Los datos

### 5.1 Cómo se leen — y por qué importa

`cargar_postgres.py` lee el Excel **celda por celda con openpyxl**, no con
`pandas.read_excel`. La razón es concreta: `codigo_ap` puede valer `"047"`, con
ceros a la izquierda. Pandas lo convierte a `47`. Como ese es el campo de cruce
con participación, leerlo mal rompe el vínculo en silencio, sin ningún error.

Por el mismo motivo la capa cruda es **todo texto**. El tipado vive en la vista,
donde se puede leer y corregir, no escondido en el script de carga.

### 5.2 Calidad

La fuente se corrigió en origen y se volvió a cargar completa: no quedan
anomalías de calidad conocidas pendientes de tratamiento (no hay `codigo_ap`
faltante, ni colisiones de posición, ni columna de banderas en la vista). Si
aparece un problema de calidad nuevo, se documenta acá cuando se detecte —
hoy no hay ninguno abierto.

### 5.3 Fuente descartada

`Vigentes elecciones.xlsx` era **byte a byte idéntico** a la planilla de
participación (mismo MD5). La vigencia de cada partido al momento de la elección
ya viene dentro de participación.

---

## 6. Garantías de calidad

### 6.1 Precisión verificable

Toda respuesta numérica se acompaña de la tabla de la que sale y del SQL que la
produjo. El usuario puede auditar. Internamente, esto permite diagnosticar
errores: se ve si falló la traducción o el dato.

### 6.2 Neutralidad

Un portal de la CNE va a recibir preguntas cargadas políticamente. El sistema
responde con datos o no responde; nunca opina, califica ni proyecta. Es una
restricción de diseño, hoy sostenida por el prompt — sin verificación
automatizada porque no hay banco de evaluación (ver 6.3).

### 6.3 Datos personales

**No requieren tratamiento especial.** El DNI y la fecha de nacimiento de las
candidaturas son de publicación oficial. No hace falta anonimizar, truncar la
fecha a año, ni separar esos datos con permisos restringidos.

### 6.4 Banco de evaluación — no implementado

Se había previsto un conjunto de preguntas con respuesta verificada
manualmente, para correr ante cada cambio de modelo, prompt o esquema y medir
si un cambio mejora o empeora las respuestas. **Se decidió no construirlo**
para llegar antes al prototipo funcional, y hoy no hay forma sistemática de
medir el impacto de un cambio de modelo o prompt — se evalúa a mano, caso por
caso. No está en el roadmap actual salvo que se retome explícitamente.

---

## 7. Etapas

### Etapa 0 — Datos ✔ cerrada
Carga a Postgres y capa semántica.

### Etapa 1 — Capa semántica ✔ parcialmente cerrada
Diccionario de términos: hecho. Ejemplos resueltos y banco de evaluación
formal: salteados a propósito, no forman parte del roadmap actual.

### Etapa 2 — Prototipo funcional ✔ cerrada
Aplicación de chat contra `v_candidaturas`, con validación de SQL, SQL visible
y manejo de fuera de alcance.

### Etapa 3 — Producción, en prueba ← acá estamos
El panel está desplegado y en uso con datos reales. Registro de todas las
preguntas en `consultas_log`, que alimenta el diccionario y eventuales ajustes
de prompt.

### Etapa 4 — Escalabilidad y mejora del modelo
No se avanza en orden estricto; son frentes en paralelo:

- **Escalabilidad de tráfico y costo** — caché de preguntas frecuentes (hoy
  cada pregunta dispara dos llamadas al modelo, sin excepción — ver sección
  8), anti-abuso (hoy no hay Turnstile ni rate limiting propio), rol de
  Postgres de solo lectura dedicado.
- **Modelo de mayor poder de razonamiento** — hoy corre `gemini-3.5-flash-lite`
  por límite de cuota del free tier (5 RPM / 20 RPD de los Flash completos vs.
  15 RPM / 500 RPD del Lite), no por elección de calidad. Pasar a un plan
  pago habilita volver a un modelo más capaz para la traducción a SQL y la
  redacción.

### Etapa 5 — Ampliación de alcance
Dos ejes:

- **Candidaturas desde 1983** — hoy el dominio arranca en 2011; extenderlo
  hacia atrás hasta el regreso de la democracia.
- **Participación de agrupaciones políticas** — vincular con la planilla de
  participación (qué partidos integraron cada alianza, vigencia por elección),
  hoy fuera de alcance. Requiere despivotear su formato ancho a formato largo
  y resolver la relación alianza-partido. Es el punto donde dbt recupera
  sentido (sección 4.1).

**Regla entre etapas:** un chat sobre datos mal modelados produce respuestas
incorrectas con apariencia de precisión, que es peor que no tener portal. Eso
sigue rigiendo aunque el orden formal de etapas se haya salteado en la
práctica.

---

## 8. Escalabilidad

**Volumen.** El dominio actual cabe entero en memoria. Si se incorporan
resultados por mesa —millones de registros—, ahí sí hay que revisar la
arquitectura; hasta entonces, Postgres sobra. Sumar candidaturas desde 1983
(sección 7) no cambia esto: sigue siendo un volumen chico.

**Tráfico.** Mecanismos, en orden de prioridad para la Etapa 4:

1. **Caché de preguntas repetidas.** Todavía no existe: cada pregunta dispara
   las dos llamadas al modelo (traducción a SQL + redacción) sin excepción.
   En un portal temático las preguntas se repiten fuertemente, así que es el
   mecanismo de mayor impacto tanto en costo como en la cuota gratuita del
   modelo.
2. **Anti-abuso.** No hay Turnstile ni límite por origen implementado; el
   único freno hoy es la cuota del proveedor del modelo, que no distingue
   tráfico legítimo de abuso.
3. **Vistas de resumen precalculadas** para los agregados más pedidos —
   evaluar si hace falta una vez que haya caché.

El costo del modelo escala con las preguntas *distintas*, no con las visitas.
Esa es la variable a monitorear, y la razón por la que la caché es la
prioridad 1 de la Etapa 4.

**Modelo de lenguaje.** El proveedor está detrás de una capa de abstracción:
cambiarlo es una variable de entorno (`GEMINI_MODEL`). Habilita pasar de free
tier a pago, cambiar a un modelo más capaz si la traducción no alcanza la
calidad esperada, o migrar a un modelo abierto autoalojado si aparece una
exigencia de que los datos no salgan de la infraestructura del organismo.

**Institucional.** La restricción más probable no es técnica:

- *Portabilidad.* Si se exige nube institucional, es Postgres estándar y se migra
  sin reescritura.
- *Independencia de personas.* La carga es un script versionado, no un
  procedimiento manual.
- *Trazabilidad.* Se registra qué se preguntó, qué SQL se ejecutó y qué se
  respondió (`consultas_log`).

---

## 9. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Respuesta incorrecta con apariencia de precisión | Alto — institucional | SQL visible; sin banco de evaluación formal, hoy se revisa a mano |
| Preguntas fuera de alcance respondidas igual | Alto | Encuadre en el prompt; sin métrica automatizada de tasa de rechazo |
| Uso político de una respuesta | Alto | Neutralidad por diseño del prompt, trazabilidad completa vía `consultas_log` |
| Sin rol de Postgres de solo lectura dedicado | Alto | Hoy la única defensa es `sql-guard.ts` + `READ ONLY` a nivel de transacción — ver 4.3 |
| Sin anti-abuso ni caché | Medio-alto | Cuota del proveedor del modelo actúa como freno de hecho, no por diseño — prioridad 1 de la Etapa 4 |
| Costo desbordado por tráfico o abuso | Medio | Ver ítem anterior; pendiente de resolver en la Etapa 4 |
| Deriva entre el dato de Looker y el del chat | Medio | Mismo archivo de origen; documentar la versión usada |
| Dependencia de una persona | Medio | Scripts versionados, documentación |

---

## 10. Decisiones abiertas

1. Cuándo pasar a un plan de Gemini pago y a qué modelo (Etapa 4).
2. Alcance del registro de preguntas (`consultas_log`) y su período de retención.
3. Si el portal se integra al sitio de la CNE o vive en un subdominio propio.
4. Prioridad relativa entre las dos ampliaciones de la Etapa 5 (1983 vs.
   participación de agrupaciones).
5. Responsable del mantenimiento una vez estabilizada la etapa de prueba.

---

## 11. Archivos

| Archivo | Qué hace |
|---|---|
| `cargar_postgres.py` | Lee el Excel e inserta en Postgres. Crea tabla y vista |
| `pg_01_tabla.sql` | DDL de la tabla cruda, todas las columnas texto |
| `pg_08_agregar_id_candidato.sql` | DDL vigente de `v_candidaturas` (capa semántica): tipado, nombres de dominio, `id_candidato`, índices |
| `diccionario_terminos.md` | Sinónimos, siglas y nombres coloquiales — fuente de `panel/lib/context.ts` |
| `panel/` | Aplicación Next.js en producción — ver `panel/README.md` para arrancarla localmente |
| `data/` | Planillas UEEDA de origen. Fuera de git |

*(Las migraciones intermedias `pg_02` a `pg_07` — pasos ya aplicados y
superados por `pg_08` — se archivaron fuera del repo activo; el esquema
vigente de `consultas_log` y `v_candidaturas` queda documentado en `pg_01` y
`pg_08`.)*

**Puesta en marcha del pipeline de carga:**

```bash
pip install openpyxl "psycopg[binary]"
export DATABASE_URL="postgresql://...pooler.supabase.com:5432/postgres"
python cargar_postgres.py
```

Usar la cadena del **session pooler** (puerto 5432): la conexión directa de
Supabase es IPv6 y no resuelve desde una red IPv4.

Si se recargan los datos: `REFRESH MATERIALIZED VIEW v_candidaturas;`

Para arrancar la aplicación (`panel/`), ver `panel/README.md`.

---

## 12. Glosario

- **Agrupación política (AP)** — Denominación bajo la cual se compite: puede ser
  un partido solo o una alianza. Se identifica por un código asignado **por
  distrito y por elección**; el mismo número en distritos distintos designa
  agrupaciones distintas.
- **Alianza** — Agrupación integrada por dos o más partidos.
- **Distrito** — Unidad electoral. 24 distritos más el ámbito nacional.
- **PASO** — Primarias Abiertas Simultáneas y Obligatorias. Instancia previa a
  las generales. **No se realizaron en 2025.**
- **Lista interna** — Dentro de una agrupación, en las PASO pueden competir
  varias listas. Se identifican por `nombre_lista`.
- **Precandidatura** — Postulación en las PASO. **Candidatura** — postulación en
  generales.
- **Parlasur** — Parlamentarios del Mercosur. Solo hay datos de 2015 y 2023.
