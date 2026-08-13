# Diccionario de términos — v_candidaturas

Mapea lenguaje coloquial a los valores exactos que tiene la vista. Se arma a
partir de los valores reales observados en el origen (`UEEDA Precandidaturas
y Candidaturas 2011 2025 v070826.xlsx`, 38.865 filas), no de supuestos.

Uso previsto: este archivo se inyecta en el prompt junto con el esquema de
`v_candidaturas`, para que el modelo traduzca la pregunta a los valores de
columna correctos.

---

## 1. Distrito (`distrito`)

Valor exacto en la base a la izquierda. 24 distritos + Distrito Único.

| Coloquial / alias | Valor exacto en `distrito` |
|---|---|
| CABA, Capital, Ciudad de Buenos Aires, la Ciudad | `CAPITAL FEDERAL` |
| Buenos Aires, PBA, Provincia de Buenos Aires | `BUENOS AIRES` |
| Santiago del Estero | `S DEL ESTERO` |
| Tierra del Fuego | `T DEL FUEGO` |
| Córdoba | `CÓRDOBA` |
| Nación, nacional, todo el país | `DISTRITO ÚNICO` (es la categoría de Presidente y Vice / Parlasur, no un distrito geográfico más) |

El resto de los distritos (Santa Fe, Tucumán, Salta, Mendoza, Chaco,
Misiones, Entre Ríos, Jujuy, San Juan, Neuquén, Corrientes, Santa Cruz,
Chubut, La Pampa, La Rioja, San Luis, Catamarca, Río Negro, Formosa) se
escriben igual en lenguaje natural que en la base — sin alias necesario,
respetar tildes.

## 2. Cargo (`cargo`)

| Coloquial | Valor exacto |
|---|---|
| diputados, diputado nacional | `DIPUTADOS NACIONALES` |
| senadores, senador nacional | `SENADORES NACIONALES` |
| Parlasur, parlamentario del Mercosur, eurodiputado (por analogía, NO usar) | `PARLAMENTARIOS DEL MERCOSUR` |
| presidente, presidencial, binomio presidencial | `PRESIDENTE Y VICE` |

Recordar el límite de 3.5 del proyecto: Parlasur solo tiene datos en 2015 y
2023; Presidente y Vice solo en 2011, 2015, 2019 y 2023.

## 3. Subcategoría (`subcategoria`)

| Coloquial | Valor exacto |
|---|---|
| titular, encabeza la lista (cuidado: "encabeza" es más específico, ver abajo) | `TITULARES` |
| suplente | `SUPLENTES` |
| vicepresidente | `VICEPRESIDENTE` |
| presidente (como candidato, no como cargo genérico) | `PRESIDENTE` |

"Encabezar una lista" no es lo mismo que `subcategoria = 'TITULARES'`: es
`subcategoria = 'TITULARES' AND posicion = 1`. Distinguir ambas preguntas.

## 4. Etapa (`etapa`)

La vista ya normaliza a texto: `PASO`, `Generales`, `Segunda vuelta`.

| Coloquial | Valor exacto |
|---|---|
| primarias, las PASO | `PASO` |
| elección general | `Generales` |
| balotaje, segunda vuelta, ballotage | `Segunda vuelta` |

Caso límite obligatorio (3.5 del proyecto): **no hubo PASO en 2025** — si la
pregunta cruza PASO con 2025, la respuesta es que no existe esa instancia,
no una tabla vacía. Segunda vuelta solo existe en 2015 y 2023 (4 candidaturas
cada una).

## 5. Género (`genero`)

| Coloquial | Valor exacto |
|---|---|
| mujeres, candidatas | `F` |
| varones, hombres, candidatos (en sentido de género) | `M` |

No hay una tercera categoría en los datos actuales.

## 6. Partidos / siglas — LLA, PRO, UCR, FIT, etc.

**Advertencia de diseño, no cosmética.** [[no-agrupar-denominaciones-electorales]]
ya estableció que cada denominación de agrupación es una entidad distinta
por distrito y por elección — el mismo nombre nominal puede corresponder a
variantes de texto distintas. Confirmado en el origen: "La Libertad Avanza"
tiene **5 variantes de `agrupacion`** (`LA LIBERTAD AVANZA`, `ALIANZA LA
LIBERTAD AVANZA`, `ALIANZA LA LIBERTAD AVANZA SAN LUIS`, `ALIANZA LA
LIBERTAD AVANZA CHUBUT`, `PARTIDO LA LIBERTAD AVANZA`); "Frente de
Izquierda" tiene **36 variantes**; "Cambiemos" tiene **30 variantes**.

Por eso una sigla o nombre coloquial **no se traduce a un valor exacto de
`agrupacion`**. Se traduce a un patrón (`ILIKE '%...%'`) que el propio SQL
generado agrupa y muestra desagregado por `agrupacion` real — nunca a un
`WHERE agrupacion = 'valor único'` que sume variantes distintas bajo un
mismo total sin que el usuario lo vea.

| Sigla / coloquial | Patrón sugerido | Nota |
|---|---|---|
| LLA, La Libertad Avanza, libertarios | `agrupacion ILIKE '%LIBERTAD AVANZA%'` | 5 variantes conocidas |
| FIT, Frente de Izquierda, izquierda (partido) | `agrupacion ILIKE '%IZQUIERDA%TRABAJADORES%'` | 36 variantes; "izquierda" a secas es demasiado amplio (matchea también "Izquierda al Frente por el Socialismo", que es otra fuerza) |
| Juntos por el Cambio, JxC | `agrupacion ILIKE '%JUNTOS POR EL CAMBIO%'` | 13 variantes |
| Cambiemos | `agrupacion ILIKE '%CAMBIEMOS%'` | 30 variantes — **no fusionar con Juntos por el Cambio**: son etiquetas de época distintas (2015/2017 vs 2019 en adelante) aunque compartan coalición |
| Frente de Todos, FdT | `agrupacion ILIKE '%FRENTE DE TODOS%'` | 7 variantes |
| Frente Renovador | `agrupacion ILIKE '%FRENTE RENOVADOR%'` | 14 variantes |
| PRO, Propuesta Republicana | `agrupacion ILIKE '%PRO%PROPUESTA REPUBLICANA%' OR agrupacion ILIKE '%UNION PRO%' OR agrupacion ILIKE '%UNIÓN PRO%'` | ojo: `ILIKE '%PRO%'` solo matchea de más (Justicialista, Progresista, etc.) |
| UCR, radicales, Unión Cívica Radical | `agrupacion ILIKE '%UNION CIVICA RADICAL%' OR agrupacion ILIKE '%UNIÓN CÍVICA RADICAL%'` | incluye una variante mal tipeada `UNION CIVICA RADICA` (sin L final) — el ILIKE con `%` la cubre igual |
| PJ, Justicialista, peronismo (como partido, no como espacio amplio) | `agrupacion ILIKE '%JUSTICIALISTA%'` | 12 variantes; "peronismo" como espacio político es más ambiguo que el partido — si la pregunta usa "peronista" en sentido amplio, aclarar antes de asumir el patrón |

**Regla general para cualquier sigla no listada acá:** generar el patrón
`ILIKE` a partir del nombre más largo y distintivo posible, ejecutar,
devolver los `agrupacion` distintos que matchearon visibles en la tabla de
resultado — igual que exige el punto 4.3 del proyecto (SQL visible) — para
que un match de más quede a la vista y no oculto en un total agregado.

## 7. Fuera de alcance — no traducir, redirigir

Términos que van a aparecer en preguntas pero no tienen columna:
"votos", "ganó", "electo", "resultado", "escrutinio" → el sistema no tiene
resultados electorales (3.4 del proyecto). "afiliados", "padrón", "vigencia
del partido" → viven en la planilla de participación, fuera del piloto.

---

*Pendiente: revisar este diccionario contra el banco de evaluación cuando
exista, y ampliarlo con los términos que aparezcan en las primeras preguntas
reales (5.4 del documento: "el diccionario es lo que más mueve la tasa de
acierto y lo más fácil de subestimar").*
