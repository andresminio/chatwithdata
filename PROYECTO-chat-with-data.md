# Proyecto: Portal conversacional sobre datos electorales — UEEDA / CNE

Documento de contexto. Refleja el estado real del proyecto, no el plan original.
Última revisión: 6 de agosto de 2026.

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

**Etapa: piloto.** Una fuente cargada, capa semántica construida y verificada.
Falta la aplicación de chat.

| Pieza | Estado |
|---|---|
| Datos en Postgres | Hecho — 38.907 filas |
| Capa semántica (`v_candidaturas`) | Hecha — 18 columnas tipadas + banderas de calidad |
| Perfilado de calidad | Hecho — 10 tipos de anomalía identificados |
| Banco de evaluación | Pendiente |
| Aplicación de chat | Pendiente |
| Participación de agrupaciones | Fuera del piloto |

---

## 3. Alcance

### 3.1 Dominio incluido

**Precandidaturas y candidaturas, 2011–2025.** Personas que se presentaron en
cada instancia electoral: PASO, generales y segunda vuelta. Por cargo, distrito,
agrupación, nombre de lista, posición en la lista, carácter de titular o
suplente, y género.

Diecisiete instancias electorales en ocho años electorales. 38.907 candidaturas,
23.251 personas distintas, 824 denominaciones de agrupación.

### 3.2 Dimensiones

- **Distrito** — 24 distritos electorales más el ámbito nacional (Distrito Único).
- **Categoría de cargo** — Presidente y Vice, Senadores Nacionales, Diputados
  Nacionales, Parlamentarios del Mercosur.
- **Etapa** — PASO, Generales, Segunda Vuelta.
- **Año electoral** — 2011, 2013, 2015, 2017, 2019, 2021, 2023, 2025.

### 3.3 Qué preguntas responde

- Quiénes se postularon, a qué cargo, por qué agrupación y en qué posición.
- Paridad de género en las listas, por distrito, cargo y elección.
- Trayectoria de una persona a lo largo de varias elecciones.
- Composición de una lista concreta.
- Comparaciones entre elecciones, entre distritos y entre agrupaciones.
- Agregados: cantidad de candidaturas por elección, por distrito, por cargo.

### 3.4 Qué NO responde — límite explícito

**El sistema no tiene resultados electorales.** No sabe quién ganó, cuántos votos
obtuvo nadie, ni quién resultó electo. Tampoco tiene padrón, afiliaciones,
autoridades de mesa, escrutinios ni financiamiento.

Esto no es un detalle operativo: *"¿quién ganó en 2023?"* va a ser una de las
preguntas más frecuentes del portal. El sistema debe reconocerla, explicar que
trabaja sobre candidaturas y no sobre resultados, y derivar al recurso oficial
correspondiente. Responder algo plausible ante una pregunta fuera de alcance es
el peor modo de falla posible para un organismo electoral.

Tratar "no puedo responder eso" como una respuesta exitosa —y medirla como tal—
es un requisito de diseño, no una limitación.

**Tampoco responde sobre partidos ni alianzas.** Qué partidos integraron cada
alianza, qué partidos estaban vigentes en cada elección y quién superó las PASO
son datos que viven en la planilla de participación, que está fuera del piloto.

### 3.5 Casos límite que el portal debe reconocer

No son huecos de datos: son hechos del calendario electoral. Una respuesta vacía
sería incorrecta; hay que explicar por qué no hay datos.

- **No hubo PASO en 2025.** Ese año tiene solo generales.
- **Parlamentarios del Mercosur solo existen en 2015 y 2023.**
- **Presidente y Vice solo en 2011, 2015, 2019 y 2023.**
- **Segunda vuelta solo en 2015 y 2023**, con 4 candidaturas cada una.

---

## 4. Arquitectura

```
data/*.xlsx  (planillas UEEDA)
   ↓  cargar_postgres.py      lee celda por celda, todo como texto
Postgres / Supabase  ·  tabla candidaturas       capa cruda
   ↓  pg_02_vista.sql         tipado, nombres de dominio, banderas de calidad
Postgres  ·  v_candidaturas (materializada)      capa semántica
   ↓
Aplicación de chat  ──→  Portal público CNE
```

### 4.1 Por qué no hay BigQuery ni dbt

El plan original tenía BigQuery como almacén, dbt para transformar y Postgres
como capa de servicio. Se descartó, y conviene dejar escrito por qué:

- **BigQuery** se justificaba por dos razones: ser la fuente única compartida con
  Looker Studio, y escalar a resultados por mesa. Ninguna aplica: no existe un
  almacén institucional de la CNE al que conectarse, y el dominio actual son
  38.907 filas, 5 MB. Postgres los resuelve en milisegundos.
- **dbt** resuelve dependencias entre modelos encadenados. Con una sola tabla de
  origen y sin uniones que resolver, no hay dependencias. Recupera sentido cuando
  se incorpore participación.

Se llegó a cargar todo en BigQuery antes de tomar esta decisión. El costo fue una
tarde; el camino queda hecho por si aparece un almacén institucional.

### 4.2 Herramientas

| Función | Herramienta | Por qué |
|---|---|---|
| Base de datos | **Supabase** (Postgres) | Milisegundos por consulta; Postgres estándar, portable |
| Carga | **openpyxl + psycopg** | Lee el Excel sin destruir los datos; ver 5.1 |
| Capa semántica | **Vista materializada** | Los datos son estáticos: se calcula una vez |
| Aplicación | **Next.js** | Interfaz de chat, tabla de resultados, SQL visible |
| Capa de modelo | **Vercel AI SDK** | Cambiar de proveedor de LLM es una variable de entorno |
| Validación SQL | **sqlglot** | Verifica el SQL generado antes de ejecutarlo |
| Hosting | **Vercel** | Free tier en prototipo |
| Anti-abuso | **Cloudflare Turnstile** | Sin costo, sin fricción para el usuario |

Criterio de selección: **ningún componente obliga a reescribir para pasar a
producción.** El único sin sustituto directo es el modelo, y por eso está detrás
de una capa de abstracción.

### 4.3 Recorrido de una pregunta

**El SQL se ejecuta en Postgres. El modelo de lenguaje nunca toca los datos:
traduce la pregunta a SQL y después redacta a partir de las filas que Postgres
ya devolvió.**

```
Navegador                Servidor (Next.js en Vercel)              Servicios
─────────                ────────────────────────────              ─────────

"¿cuántas mujeres
 encabezaron listas  ──→  1. recibe la pregunta
 en Córdoba 2023?"        2. busca en caché; si acierta, salta al 6

                          3. encuadre: ¿está dentro del alcance?
                             si no → respuesta explicativa, sin SQL

                          4. arma el prompt:
                             pregunta + esquema de v_candidaturas
                             + diccionario + ejemplos    ──────────→  LLM
                                                          ←──────────  devuelve
                                                                       SOLO texto SQL

                          5. valida el SQL (sqlglot):
                             ¿es SELECT? ¿solo v_candidaturas?
                             ¿tiene LIMIT? → si no, rechaza

                          6. EJECUTA el SQL          ───────────────→  Postgres
                             (rol de solo lectura,                     (Supabase)
                              timeout máximo)         ←───────────────  filas

                          7. manda esas filas al LLM
                             para redactar             ──────────────→  LLM
                                                       ←──────────────  prosa

  respuesta +         ←──  8. devuelve prosa + tabla + el SQL ejecutado
  tabla + SQL
```

**Dónde corre cada cosa.** Los pasos 1 a 8 son la aplicación Next.js, del lado
del servidor. El navegador solo muestra. El cálculo ocurre íntegramente en
Postgres, en el paso 6.

**El modelo se invoca dos veces y nunca calcula.** La primera vez recibe el
esquema, no datos. La segunda recibe únicamente las filas que devolvió Postgres.
Si el modelo inventa una cifra, se introduce en el paso 7 — y por eso la tabla
va visible junto a la respuesta: el desvío queda a la vista.

**El navegador nunca habla con Postgres.** La cadena de conexión vive solo en el
servidor. Si el navegador consultara directo, las credenciales quedarían
expuestas en el código de la página.

**El paso 7 envía datos al proveedor del modelo** — las filas del resultado, no
la base. Con datos públicos no representa un problema, pero es el punto a
revisar si alguna vez entra información que no lo sea.

### 4.4 La capa semántica

Es el activo técnico central del proyecto y lo que determina la tasa de acierto.

**`v_candidaturas`** — el modelo nunca ve la tabla cruda. Ve una vista
materializada de 18 columnas, tipadas y con nombres en lenguaje del dominio. La
traducción a SQL falla sobre todo al resolver uniones entre tablas; acá no hay
ninguna que resolver.

**Diccionario de términos** *(pendiente)* — sinónimos, siglas y nombres
coloquiales: "CABA" y "Capital Federal", "diputados" y "Diputados Nacionales",
"Parlasur", "las PASO", "LLA". En la práctica es lo que más mueve la tasa de
acierto, y lo más fácil de subestimar.

**Ejemplos resueltos** *(pendiente)* — pares pregunta–SQL correcta incluidos en
el contexto, cubriendo los patrones típicos: filtro temporal, comparación entre
elecciones, agregación por distrito, conteo por género.

---

## 5. Los datos

### 5.1 Cómo se leen — y por qué importa

`cargar_postgres.py` lee el Excel **celda por celda con openpyxl**, no con
`pandas.read_excel`. La razón es concreta: `Codigo AP` vale `"047"`, con ceros a
la izquierda. Pandas lo convierte a `47`. Como ese es el campo de cruce con
participación, leerlo mal rompe el vínculo en silencio, sin ningún error.

Por el mismo motivo la capa cruda es **todo texto**. El tipado vive en la vista,
donde se puede leer y corregir, no escondido en el script de carga.

### 5.2 Calidad: qué se encontró

**38.401 de 38.907 filas no tienen ninguna anomalía: 98,7%.**

Las filas problemáticas **no se eliminan, se marcan** en la columna `anomalias`.
Un candidato que existió sigue existiendo aunque su posición esté mal cargada.

| Bandera | Filas | Qué es |
|---|---|---|
| `genero_inconsistente` | 108 | 29 DNI con género distinto según la elección. Afecta cualquier cálculo de paridad agrupado por persona |
| `lista_incompleta` | 125 | 36 listas cuya numeración no arranca en 1 o tiene huecos |
| `agrupacion_texto_roto` | 76 | `Unión Para Vivir Mejor (503` truncada; `Frente De Izquierda... ()` con paréntesis vacío |
| `sin_posicion` | 75 | 64 son de PASO 2015 y explican falsos duplicados |
| `identificador_invalido` | 63 | DNI, id_candidato o apellido faltante. Incluye 6 DNI de un solo dígito |
| `dni_en_varias_agrupaciones` | 43 | 20 personas en más de una agrupación en la misma instancia |
| `posicion_duplicada` | 30 | 15 grupos con dos personas en la misma posición |
| `dni_repetido_en_lista` | 22 | La misma persona dos veces en la misma lista |
| `sin_codigo_agrupacion` | 21 | Huecos aislados fuera de 2021 |
| `edad_imposible` | 1 | Menor de 18 al momento de la elección |

Consultar solo filas limpias: `WHERE cardinality(anomalias) = 0`.

### 5.3 Problemas estructurales, no marcables

**`codigo_ap` falta en el 100% de 2021.** No es un problema de calidad disperso:
es un año cargado con otro criterio. Cuando se incorpore participación, 2021 no
va a cruzar por código. Requiere decisión de dominio.

**Las 15 colisiones de posición no tienen solución en esta tabla.** Son listas
internas paralelas cargadas con el mismo `nombre_lista`. Se verificó que ni
`codigo_ap` ni `candidatura` las separan —`candidatura` resultó ser
`Nombres + Apellido` concatenado, no un identificador—. Requiere corrección en
origen.

**La capitalización de `ap` sigue al año, no al distrito.** 2013, 2015 y 2017
están enteros en formato título; el resto en mayúsculas. Como cada distrito
oficializa sus propias denominaciones, no se unifica: se deja como está.

### 5.4 Fuente descartada

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
restricción de diseño con verificación explícita en las pruebas.

### 6.3 Datos personales

**No requieren tratamiento especial.** El DNI y la fecha de nacimiento de las
candidaturas son de publicación oficial. No hace falta anonimizar, truncar la
fecha a año, ni separar esos datos con permisos restringidos.

*(Este punto corrige una versión anterior del documento que exigía lo contrario
y lo señalaba como bloqueante de la etapa 3.)*

### 6.4 Banco de evaluación

Un conjunto de preguntas con respuesta verificada manualmente, que se ejecuta
ante cada cambio de modelo, prompt o esquema. Debe cubrir:

- Preguntas frecuentes esperadas.
- Los casos límite de 3.5: PASO 2025, Parlasur, segunda vuelta.
- Preguntas ambiguas que deben pedir precisión.
- Preguntas fuera de alcance que deben ser rechazadas: resultados, partidos.
- Preguntas cargadas políticamente que deben mantener neutralidad.

Sin este banco no hay forma de saber si un cambio mejoró o empeoró el sistema.
Es el artefacto más habitualmente omitido y el que más determina si el proyecto
llega a producción.

---

## 7. Etapas

### Etapa 0 — Datos ✔ cerrada
Carga a Postgres, capa semántica, perfilado de calidad. Las banderas de la vista
coinciden con el perfilado independiente en las 10 categorías.

### Etapa 1 — Capa semántica y evaluación ← acá estamos
Diccionario de términos, ejemplos resueltos y primera versión del banco de
evaluación.

*Cierra cuando:* existe un banco de al menos varias decenas de preguntas con
respuesta verificada.

### Etapa 2 — Prototipo funcional
Aplicación de chat contra `v_candidaturas`, con validación de SQL, SQL visible y
manejo de fuera de alcance. Uso interno.

*Cierra cuando:* supera el umbral de acierto definido sobre el banco.

### Etapa 3 — Piloto institucional
Presentación a autoridades y prueba con usuarios internos. Registro de todas las
preguntas formuladas, que alimentan el diccionario y el banco.

*Cierra cuando:* hay aprobación institucional.

### Etapa 4 — Producción pública
Integración al sitio de la CNE, protección anti-abuso, caché, monitoreo, límites
de gasto y procedimiento de actualización documentado.

### Etapa 5 — Ampliación
Incorporación de participación de agrupaciones, y después resultados
electorales. Participación requiere despivotear el formato ancho a formato
largo, resolver la relación alianza-partido y el hueco de `codigo_ap` en 2021.
Es el punto donde dbt recupera sentido.

**Regla entre etapas:** no se avanza sin cerrar la anterior. Un chat sobre datos
mal modelados produce respuestas incorrectas con apariencia de precisión, que es
peor que no tener portal.

---

## 8. Escalabilidad

**Volumen.** El dominio actual cabe entero en memoria. Si se incorporan
resultados por mesa —millones de registros—, ahí sí hay que revisar la
arquitectura; hasta entonces, Postgres sobra.

**Tráfico.** Tres mecanismos, en orden de efectividad:

1. **Caché.** En un portal temático las preguntas se repiten fuertemente. Una
   tasa alta de aciertos reduce el costo por consulta casi a cero y es lo que
   hace viable el tráfico público.
2. **Vistas de resumen precalculadas** para los agregados más pedidos.
3. **Límites por origen** y verificación anti-bot.

El costo del modelo escala con las preguntas *distintas*, no con las visitas.
Esa es la variable a monitorear.

**Modelo de lenguaje.** El proveedor está detrás de una capa de abstracción:
cambiarlo es una variable de entorno. Habilita pasar de free tier a pago, cambiar
a un modelo más capaz si la traducción no alcanza el umbral, o migrar a un modelo
abierto autoalojado si aparece una exigencia de que los datos no salgan de la
infraestructura del organismo.

**Institucional.** La restricción más probable no es técnica:

- *Portabilidad.* Si se exige nube institucional, es Postgres estándar y se migra
  sin reescritura.
- *Independencia de personas.* La carga es un script versionado, no un
  procedimiento manual.
- *Trazabilidad.* Se registra qué se preguntó, qué SQL se ejecutó y qué se
  respondió.

---

## 9. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Respuesta incorrecta con apariencia de precisión | Alto — institucional | SQL visible, banco de evaluación, rechazo explícito ante duda |
| Preguntas fuera de alcance respondidas igual | Alto | Encuadre previo, medición del rechazo como métrica |
| Uso político de una respuesta | Alto | Neutralidad verificada, trazabilidad completa |
| Casos límite devueltos como vacío | Medio | Los cuatro de 3.5, explícitos en el banco de evaluación |
| Costo desbordado por tráfico o abuso | Medio | Caché, límites de gasto, anti-bot |
| Deriva entre el dato de Looker y el del chat | Medio | Mismo archivo de origen; documentar la versión usada |
| Dependencia de una persona | Medio | Scripts versionados, documentación, procedimiento escrito |

---

## 10. Decisiones abiertas

1. Umbral de acierto exigido para habilitar la apertura pública.
2. Alcance del registro de preguntas y su período de retención.
3. Si el portal se integra al sitio de la CNE o vive en un subdominio propio.
4. Qué hacer con `codigo_ap` en 2021 cuando se incorpore participación.
5. Si las 15 colisiones de posición se corrigen en origen o se documentan.
6. Responsable del mantenimiento una vez en producción.

---

## 11. Archivos

| Archivo | Qué hace |
|---|---|
| `cargar_postgres.py` | Lee el Excel e inserta en Postgres. Crea tabla y vista |
| `pg_01_tabla.sql` | DDL de la tabla cruda, todas las columnas texto |
| `pg_02_vista.sql` | Capa semántica: tipado, nombres de dominio, banderas, índices |
| `data/` | Planillas UEEDA de origen. Fuera de git |

**Puesta en marcha:**

```bash
pip install openpyxl "psycopg[binary]"
export DATABASE_URL="postgresql://...pooler.supabase.com:5432/postgres"
python cargar_postgres.py
```

Usar la cadena del **session pooler** (puerto 5432): la conexión directa de
Supabase es IPv6 y no resuelve desde una red IPv4.

Si se recargan los datos: `REFRESH MATERIALIZED VIEW v_candidaturas;`

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
