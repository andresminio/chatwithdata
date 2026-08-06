# Proyecto: Portal conversacional sobre datos electorales — UEEDA / CNE

Documento de contexto. Define alcance, contenido, arquitectura, etapas y
criterios de escalabilidad. No incluye esquemas de tablas: el modelo físico se
define en BigQuery + dbt y va a cambiar.

---

## 1. Qué es

Un portal público en el sitio de la CNE donde cualquier persona puede preguntar
en lenguaje natural sobre datos de partidos políticos, alianzas y candidaturas, y
recibe una respuesta construida a partir de una consulta SQL real sobre los datos
oficiales de la UEEDA.

No es un buscador ni un tablero. La diferencia con Looker Studio —que ya cubre la
visualización— es que acá el usuario no necesita saber qué tablero abrir ni cómo
filtrarlo. Formula la pregunta como la piensa.

**Principio rector:** cada cifra que el portal muestre debe provenir de una
consulta ejecutada y auditable. El modelo de lenguaje traduce e interpreta; nunca
calcula ni recuerda datos.

---

## 2. Contenido

### 2.1 Alcance inicial

Tres dominios, período **2011–2025** (elecciones nacionales: 2011, 2013, 2015,
2017, 2019, 2021, 2023, 2025).

**Partidos políticos**
Registro histórico con vigencia. Reconocimiento, distrito, número de partido,
sigla, pertenencia a partido nacional, y el intervalo durante el cual cada
registro estuvo vigente. Permite reconstruir el estado del registro partidario en
cualquier fecha del período, no solo el actual.

**Alianzas y participación**
Para cada elección: qué partidos participaron, en qué distrito, para qué
categoría de cargo, y bajo qué forma (individualmente, en alianza, o sin
participar). Incluye si superó las PASO, si se presentó a generales y si obtuvo
representación. La composición de cada alianza —qué partidos la integraron— es
información derivada, no cargada a mano.

**Precandidaturas y candidaturas**
Personas que se presentaron en cada instancia electoral: PASO, generales y
segunda vuelta. Por cargo, distrito, agrupación, nombre de lista, posición en la
lista, carácter de titular o suplente, y género.

### 2.2 Dimensiones transversales

- **Distrito** — 24 distritos electorales más el ámbito nacional (Distrito Único).
- **Categoría de cargo** — Presidente y Vice, Senadores Nacionales, Diputados
  Nacionales, Parlamentarios del Mercosur (nacional y regional).
- **Etapa** — PASO, Generales, Segunda Vuelta.
- **Año / proceso electoral.**

### 2.3 Qué preguntas responde

- Composición y evolución del registro partidario, por distrito y en el tiempo.
- Trayectoria de participación de un partido a lo largo de los ocho procesos.
- Composición de alianzas y cómo se recompusieron entre elecciones.
- Quiénes se postularon, a qué cargo, por qué agrupación y en qué posición.
- Agregados: cantidad de agrupaciones por elección, paridad de género en las
  listas, cantidad de partidos que superaron las PASO, y similares.
- Comparaciones entre elecciones, entre distritos y entre agrupaciones.

### 2.4 Qué NO responde — límite explícito

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

---

## 3. Arquitectura

### 3.1 Capas

```
Fuentes (planillas UEEDA, sistemas internos)
   ↓
BigQuery — capa cruda
   ↓  dbt: staging → intermedias → marts
BigQuery — modelo analítico  ──────→  Looker Studio (ya existente)
   ↓  dbt: capa semántica
Vistas de servicio (desnormalizadas, pensadas para preguntas)
   ↓  materialización
Capa de servicio (Postgres / Supabase)
   ↓
Aplicación de chat  ──→  Portal público CNE
```

**Separación central:** BigQuery es el almacén y el lugar donde se gobierna el
dato. La capa de servicio existe solo para responder rápido. El chat nunca
consulta BigQuery en vivo — pagaría latencia de segundos por pregunta.

### 3.2 Herramientas

| Función | Herramienta | Por qué |
|---|---|---|
| Almacén | **BigQuery** | Ya es la fuente de verdad y alimenta Looker |
| Transformación | **dbt** | Versionado en git, tests de datos, linaje, documentación |
| Capa de servicio | **Supabase** (Postgres) | Milisegundos por consulta; Postgres estándar, portable |
| Conexión BQ↔PG | **Supabase Wrappers** (FDW) | Lee BigQuery sin duplicar el dato |
| Refresco | **pg_cron** | Programado en SQL, sin orquestador externo |
| Aplicación | **Next.js** | Interfaz de chat, tabla de resultados, SQL visible |
| Capa de modelo | **Vercel AI SDK** | Cambiar de proveedor de LLM es una variable de entorno |
| Modelo | **Gemini Flash** (inicio) | Free tier para prototipo; intercambiable |
| Validación SQL | **sqlglot** | Verifica el SQL generado antes de ejecutarlo |
| Hosting | **Vercel** | Free tier en prototipo, plan pago o contenedor propio después |
| Anti-abuso | **Cloudflare Turnstile** | Sin costo, sin fricción para el usuario |
| Caché | Postgres → **Redis** | Absorbe la repetición de preguntas |

Criterio de selección: **ningún componente obliga a reescribir para pasar a
producción.** Todo tiene un plan pago directo o es autoalojable. El único
componente sin sustituto directo es el modelo, y por eso está detrás de una capa
de abstracción.

### 3.3 Recorrido de una pregunta

1. **Normalización y caché.** Se busca la pregunta en el caché. Si hay coincidencia,
   se responde sin invocar al modelo.
2. **Encuadre.** Se determina si la pregunta está dentro del alcance. Fuera de
   alcance (resultados, opiniones, temas ajenos) → respuesta explicativa, sin SQL.
3. **Traducción.** El modelo recibe la capa semántica, el diccionario de términos
   y ejemplos resueltos, y produce SQL.
4. **Validación determinista.** Solo `SELECT`, solo sobre vistas autorizadas,
   `LIMIT` obligatorio, sin acceso a catálogos del sistema. Rechazo si no cumple.
5. **Ejecución.** Rol de solo lectura, con tiempo máximo de consulta.
6. **Redacción.** El modelo redacta a partir del resultado obtenido, sin agregar
   cifras que no estén en la tabla.
7. **Presentación.** Respuesta, tabla de datos, y el SQL ejecutado desplegable.

### 3.4 La capa semántica

Es el activo técnico central del proyecto, y lo que determina la tasa de acierto.
Tres componentes:

**Vistas de servicio.** El modelo nunca ve las tablas del almacén. Ve un conjunto
acotado de vistas desnormalizadas, con nombres de columna en lenguaje del dominio
y las relaciones ya resueltas. La traducción a SQL falla sobre todo al resolver
uniones entre tablas; si no hay uniones que resolver, el problema desaparece.
Además desacopla: el modelo físico puede reestructurarse sin tocar los prompts.

**Diccionario de términos.** Sinónimos, siglas, nombres coloquiales y formas
abreviadas. "CABA" y "Capital Federal", "diputados" y "Diputados Nacionales",
"Parlasur", "las PASO", "la Libertad Avanza" y "LLA", nombres de alianzas que
cambiaron de denominación entre elecciones. En la práctica es lo que más mueve la
tasa de acierto, y es también lo más fácil de subestimar.

**Ejemplos resueltos.** Un conjunto de pares pregunta–SQL correcta que se incluye
en el contexto, cubriendo los patrones típicos: filtro temporal, comparación
entre elecciones, agregación por distrito, recorrido de la relación
alianza-partido.

---

## 4. Garantías de calidad

### 4.1 Precisión verificable

Toda respuesta numérica se acompaña de la tabla de la que sale y del SQL que la
produjo. El usuario puede auditar. Internamente, esto además permite diagnosticar
errores: se ve si falló la traducción o el dato.

### 4.2 Neutralidad

Un portal de la CNE va a recibir preguntas cargadas políticamente —"¿qué partido
es mejor?", "¿cuál es más corrupto?", pedidos de proyección o interpretación
partidaria. El sistema responde con datos o no responde; nunca opina, califica ni
proyecta. Es una restricción de diseño con verificación explícita en las pruebas.

### 4.3 Datos personales

Las candidaturas contienen documento de identidad y fecha de nacimiento. El
nombre de un candidato es información pública; el documento no lo es. La capa
expuesta al portal excluye documento y reduce la fecha de nacimiento a año, y los
identificadores derivados del documento se reemplazan por identificadores
propios. Requiere validación del área legal antes de la apertura pública.

### 4.4 Banco de evaluación

Un conjunto de preguntas con respuesta verificada manualmente, que se ejecuta
ante cada cambio de modelo, prompt o esquema. Debe cubrir:

- Preguntas frecuentes esperadas.
- Casos límite: años sin cierta categoría, distritos sin senadores ese ciclo,
  partidos con cambio de denominación.
- Preguntas ambiguas que deben pedir precisión.
- Preguntas fuera de alcance que deben ser rechazadas correctamente.
- Preguntas cargadas políticamente que deben mantener neutralidad.

Sin este banco no hay forma de saber si un cambio mejoró o empeoró el sistema.
Es el artefacto más habitualmente omitido y el que más determina si el proyecto
llega a producción. Debe existir desde la etapa 1.

---

## 5. Etapas

### Etapa 0 — Fundaciones de datos
Modelado en dbt: normalización de la participación a formato largo,
reconstrucción de la relación alianza-partido, unificación de nomenclaturas entre
fuentes, resolución de las candidaturas sin código de agrupación, tests de
integridad y de unicidad.

*Cierra cuando:* los cruces entre los tres dominios superan el umbral acordado y
los tests de dbt pasan en verde.

### Etapa 1 — Capa semántica y evaluación
Vistas de servicio, diccionario de términos, ejemplos resueltos y primera versión
del banco de evaluación.

*Cierra cuando:* existe un banco de al menos varias decenas de preguntas con
respuesta verificada.

### Etapa 2 — Prototipo funcional
Aplicación de chat completa contra la capa de servicio, con validación de SQL,
SQL visible y manejo de fuera de alcance. Uso interno.

*Cierra cuando:* supera el umbral de acierto definido sobre el banco de evaluación.

### Etapa 3 — Piloto institucional
Presentación a autoridades y prueba con usuarios internos reales. Registro de
todas las preguntas formuladas, que alimentan el diccionario y el banco.

*Cierra cuando:* hay aprobación institucional y validación legal de la exposición
de datos.

### Etapa 4 — Producción pública
Integración al sitio de la CNE, protección anti-abuso, caché, monitoreo, límites
de gasto y procedimiento de actualización documentado.

*Cierra cuando:* opera de forma estable y el mantenimiento no depende de una
persona en particular.

### Etapa 5 — Ampliación
Incorporación de nuevos dominios según prioridad institucional. El candidato
natural son los resultados electorales, que además es lo que los usuarios más van
a pedir.

**Regla entre etapas:** no se avanza sin cerrar la anterior. Un chat sobre datos
mal modelados produce respuestas incorrectas con apariencia de precisión, que es
peor que no tener portal.

---

## 6. Escalabilidad

### 6.1 Volumen de datos

El diseño no depende del tamaño porque BigQuery ya es la fuente. Los dominios
actuales son pequeños —decenas de miles de registros— y se materializan
íntegramente en la capa de servicio. Si se incorporan resultados por mesa
—millones de registros—, esos quedan en BigQuery y se consultan mediante tabla
foránea o agregados materializados. La aplicación sigue hablándole solo a
Postgres: no cambia la capa semántica ni los prompts.

### 6.2 Tráfico

Tres mecanismos, en orden de efectividad:

1. **Caché.** En un portal temático las preguntas se repiten fuertemente. Una tasa
   alta de aciertos de caché reduce el costo por consulta casi a cero y es lo que
   hace viable el tráfico público.
2. **Vistas de resumen precalculadas** para los agregados más pedidos.
3. **Límites por origen** y verificación anti-bot.

El costo del modelo escala con las preguntas *distintas*, no con las visitas.
Esa es la variable a monitorear.

### 6.3 Modelo de lenguaje

El proveedor está detrás de una capa de abstracción: cambiar de modelo es una
variable de entorno. Habilita tres movimientos sin rediseño: pasar de free tier a
pago al crecer el tráfico, cambiar a un modelo más capaz si la traducción no
alcanza el umbral, o migrar a un modelo abierto autoalojado si aparece una
exigencia de que los datos no salgan de la infraestructura del organismo.

### 6.4 Escalabilidad institucional

La restricción más probable no es técnica. Tres previsiones:

- **Portabilidad de infraestructura.** Si se exige que todo resida en la nube
  institucional, la capa de servicio es Postgres estándar y se migra sin
  reescritura.
- **Independencia de personas.** Todo transformación vive en dbt versionado, no en
  scripts individuales. La actualización de datos no requiere intervención manual.
- **Trazabilidad.** Se registra qué se preguntó, qué SQL se ejecutó y qué se
  respondió. Es necesario para auditoría, para mejorar el sistema y para responder
  ante un cuestionamiento sobre una respuesta puntual.

---

## 7. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Respuesta incorrecta con apariencia de precisión | Alto — institucional | SQL visible, banco de evaluación, rechazo explícito ante duda |
| Cruces mal resueltos entre dominios | Alto — silencioso | Tests de integridad en dbt, etapa 0 bloqueante |
| Preguntas fuera de alcance respondidas igual | Alto | Encuadre previo, medición del rechazo como métrica |
| Uso político de una respuesta | Alto | Neutralidad verificada, trazabilidad completa |
| Exposición de datos personales | Alto — legal | Capa expuesta sin documento, validación legal previa |
| Costo desbordado por tráfico o abuso | Medio | Caché, límites de gasto, anti-bot |
| Deriva entre el dato de Looker y el del chat | Medio | Fuente única en BigQuery, misma capa dbt |
| Dependencia de una persona | Medio | dbt versionado, documentación, procedimiento escrito |

---

## 8. Decisiones abiertas

1. Política institucional sobre exposición de datos personales de candidaturas.
2. Umbral de acierto exigido para habilitar la apertura pública.
3. Alcance del registro de preguntas y su período de retención.
4. Si el portal se integra al sitio de la CNE o vive en un subdominio propio.
5. Si hay exigencia de nube institucional, y cuál.
6. Responsable del mantenimiento una vez en producción.

---

## 9. Glosario

- **Agrupación política (AP)** — Denominación bajo la cual se compite: puede ser un
  partido solo o una alianza. Se identifica por un código asignado **por distrito
  y por elección**; el mismo número en distritos distintos designa agrupaciones
  distintas.
- **Alianza** — Agrupación integrada por dos o más partidos.
- **Distrito** — Unidad electoral. 24 distritos más el ámbito nacional.
- **PASO** — Primarias Abiertas Simultáneas y Obligatorias. Instancia previa a las
  generales.
- **Precandidatura** — Postulación en las PASO. **Candidatura** — postulación en
  generales.
- **Parlasur** — Parlamentarios del Mercosur. Se elige en dos categorías: nacional
  (distrito único) y regional (por distrito).
- **Vigencia de partido** — Intervalo durante el cual un registro partidario estuvo
  vigente. Permite consultar el estado del registro en cualquier fecha pasada.
