# Panel — chat sobre candidaturas (piloto interno)

Implementa el recorrido de una pregunta descrito en `PROYECTO-chat-with-data.md`
(4.3), con Gemini Flash como modelo vía Vercel AI SDK.

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
- `GEMINI_MODEL` (opcional) — default `gemini-3.5-flash-lite`. Se eligió una
  variante "Lite" a propósito: los Flash completos (3.6, 3.5, 2.5, 3)
  comparten el mismo límite gratuito de 5 RPM / 20 RPD, que dos llamadas por
  pregunta agotan en minutos; los "Flash Lite" de la línea 3.x dan 15 RPM /
  500 RPD. Si el piloto pasa a un plan pago, tiene sentido volver a un Flash
  completo por calidad de redacción — ver "Pendiente" más abajo.

## Estructura

| Archivo | Qué hace |
|---|---|
| `lib/context.ts` | Esquema de `v_candidaturas`, reglas de SQL, casos límite y diccionario de términos — se inyecta como contexto del modelo en cada llamada |
| `lib/sql-guard.ts` | Valida el SQL que devuelve el modelo antes de ejecutarlo: solo SELECT, solo `v_candidaturas`, sin DDL/DML, fuerza LIMIT |
| `lib/db.ts` | Ejecuta el SELECT validado en una transacción de solo lectura contra Postgres, con timeout |
| `app/api/consulta/route.ts` | Endpoint `POST /api/consulta`: pregunta → SQL (Gemini) → validación → ejecución → prosa (Gemini) |
| `app/page.tsx` | UI mínima: input de pregunta, respuesta, SQL visible, tabla de resultados |

## Pendiente para pasar de piloto interno a Etapa 2 cerrada

Según la sección 7 del documento del proyecto, esto es un prototipo funcional
sin banco de evaluación todavía. Falta, en orden de prioridad:

0. **Pasar a un plan de Gemini con cuota paga.** El plan gratuito de los
   Flash "completos" (3.6, 3.5, 2.5, 3) limita a 5 solicitudes/minuto y 20
   solicitudes/día, y cada pregunta dispara dos llamadas al modelo
   (traducción a SQL + redacción) — se agota en minutos. Como paso
   intermedio, el default pasó a `gemini-3.5-flash-lite` (15 RPM / 500 RPD
   en el free tier, ver "Variables de entorno" arriba), que alcanza para
   demos con uso normal pero puede perder algo de precisión frente al Flash
   completo — falta verificar eso con el banco de evaluación (punto 1). El
   código también distingue el error de cuota de un error real (ver
   "Mensajes de la interfaz" abajo) y ofrece un botón "Reintentar", pero eso
   es un parche de UX, no la solución de fondo.
1. Banco de evaluación (6.4 / etapa 1) — sin esto no hay forma de medir si
   un cambio de prompt mejora o empeora las respuestas.
2. Ejemplos resueltos (pregunta–SQL) en `lib/context.ts`, para los patrones
   típicos: filtro temporal, comparación entre elecciones, agregación por
   distrito, conteo por género.
3. Caché de preguntas repetidas (8 del documento) — hoy cada pregunta
   dispara dos llamadas al modelo, sin excepción. Además de latencia, esto
   es lo que agota la cuota gratuita al doble de velocidad (punto 0).
4. Rol de Postgres de solo lectura dedicado, en vez de las credenciales
   completas del session pooler.
5. Reemplazar el validador de SQL basado en reglas (`sql-guard.ts`) por un
   parser real si aparecen falsos negativos — el documento preveía
   `sqlglot`, que no corre en el runtime de Node/Vercel.

## Mensajes de la interfaz

Catálogo de todos los textos que puede ver el usuario, para referencia al
presentar el prototipo. Los mensajes de error "fijos" son casos técnicos que
no debería ver un usuario en uso normal.

### Textos fijos de la interfaz (siempre visibles)

| Elemento | Texto |
|---|---|
| Badge | "Asistente IA" |
| Título | "Chateá con los datos electorales" |
| Descripción | "Accedé a información sobre precandidaturas y candidaturas electorales de 2011 a 2025 mediante lenguaje natural." |
| Placeholder del buscador | "¿Cuántas mujeres encabezaron listas de diputados en Córdoba en 2025?" |
| Botón | "Preguntar" (y "Consultando..." mientras espera respuesta) |
| Etiquetas de filtro | Candidaturas \| Totales \| Por distrito \| Por género \| PASO \| GENERALES \| 2025 |
| Título del desplegable SQL | "Consulta realizada por la IA" |

### Mensajes generados por la IA (varían según la consulta)

- **Respuesta normal**: la redacta la IA en base a las filas devueltas.
- **Pregunta fuera de alcance** (pide resultados electorales, votos, quién
  ganó, etc.): la IA redacta la explicación del límite; si no lo genera, cae
  en el texto por defecto: "Esta consulta no puede responderse con la
  información disponible. Los datos corresponden a candidaturas y
  precandidaturas electorales."

### Mensajes de error fijos (casos técnicos)

| Escenario | Mensaje |
|---|---|
| Body inválido | "No pudimos procesar la consulta. Intentá nuevamente." |
| Sin pregunta | "Escribí una pregunta para poder ayudarte." |
| Falla la traducción a SQL | "No pudimos procesar tu consulta. Intentá reformularla o probar con otra pregunta." |
| Se agotó la cuota gratuita de la IA (20 solicitudes/min) | "Estamos recibiendo muchas consultas en este momento (límite del plan gratuito de la IA). Probá de nuevo en unos [N] segundos." — con botón "Reintentar" |
| El modelo no devolvió SQL | "No pudimos procesar tu consulta. Intentá nuevamente." |
| SQL rechazado por el validador de seguridad | "No pudimos procesar esta consulta. Intentá formularla de otra manera." |
| Falla la ejecución contra la base | "No pudimos obtener la información en este momento. Intentá nuevamente." |
| Falla la redacción de la respuesta, pero sí hay datos | "Podés ver la información que buscabas a continuación." |
| Falla la conexión desde el navegador (fetch) | "No pudimos conectarnos con el servicio. Verificá tu conexión e intentá nuevamente." |

## Nota sobre esta entrega

El código no se pudo compilar de punta a punta (`npm run build`) dentro del
sandbox de esta sesión: la instalación de `node_modules` se truncó
repetidamente por límites de red/tiempo del entorno, y algunos archivos
quedaron con permisos que impidieron limpiarlos desde acá. Se revisó el
código a mano (tipos, imports, sintaxis de Postgres) pero conviene correr
`npm install && npm run build` en tu máquina antes de darlo por cerrado. Si
`node_modules/` ya existe y da error de instalación, borrarlo primero.
