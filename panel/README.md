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
- `GEMINI_MODEL` (opcional) — default `gemini-3.5-flash-lite`. Se eligió una
  variante "Lite" a propósito: los Flash completos (3.6, 3.5, 2.5, 3)
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
| `app/api/consulta/route.ts` | Endpoint `POST /api/consulta`: pregunta → SQL (Gemini) → validación → ejecución → prosa (Gemini). Registra cada paso en `consultas_log` |
| `app/api/reportar/route.ts` | Endpoint para marcar una respuesta puntual como reportada por el usuario |
| `app/page.tsx` | UI: input de pregunta (con dictado por voz), chips de filtro (Totales/Listado, distrito, género, cargo, etapa, año), tabla de resultados con descarga a Excel, SQL visible, recorrido guiado de onboarding (tour de pasos) y disclaimer de contenido generado por IA |

## Pendiente

Según `PROYECTO-chat-with-data.md` (sección 7, Etapas 4 y 5), lo que sigue no
es "cerrar el piloto" — ya está en producción — sino estos frentes:

1. **Caché de preguntas repetidas.** No existe todavía: cada pregunta dispara
   dos llamadas al modelo (traducción a SQL + redacción), sin excepción. Es
   la prioridad de escalabilidad más alta, tanto por costo como porque agota
   la cuota gratuita del modelo al doble de velocidad.
2. **Anti-abuso.** No hay Turnstile ni rate limiting propio; el único freno
   hoy es la cuota del proveedor del modelo, que no distingue tráfico
   legítimo de abuso.
3. **Modelo de mayor poder de razonamiento.** Hoy corre `gemini-3.5-flash-lite`
   por límite de cuota del free tier, no por elección de calidad. Requiere
   pasar a un plan pago.
4. **Rol de Postgres de solo lectura dedicado**, en vez de las credenciales
   completas del session pooler.
5. **Ampliación de alcance** (Etapa 5, más grande): sumar candidaturas desde
   1983 y vincular con la planilla de participación de agrupaciones políticas.

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
| Falla la redacción de la respuesta, pero sí hay datos | "Podés ver la información que buscabas a continuación." |
| Falla la conexión desde el navegador (fetch) | "No pudimos conectarnos con el servicio. Verificá tu conexión e intentá nuevamente." |
