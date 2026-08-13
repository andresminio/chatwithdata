/**
 * Contexto fijo que se inyecta en cada llamada al modelo: esquema de
 * v_candidaturas, reglas de alcance y diccionario de términos.
 *
 * Fuente de verdad: PROYECTO-chat-with-data.md y diccionario_terminos.md,
 * un nivel arriba de panel/. Este archivo es un resumen compacto pensado
 * para prompt, no un reemplazo — si el diccionario cambia, actualizar acá
 * a mano.
 */

export const ESQUEMA_VISTA = `
Tabla única disponible: v_candidaturas (vista materializada, Postgres).
Una fila = una candidatura (precandidatura en PASO, candidatura en Generales
y Segunda vuelta). NO hay otras tablas para consultar.

Columnas:
- eleccion        integer   año electoral: 2011, 2013, 2015, 2017, 2019, 2021, 2023, 2025
- etapa           text      'PASO' | 'Generales' | 'Segunda vuelta'
- fecha_eleccion  date
- id_distrito     integer
- distrito        text      24 distritos + 'DISTRITO ÚNICO' (ver diccionario)
- codigo_agrupacion text    se asigna por distrito y por elección — el mismo número en distritos distintos es OTRA agrupación
- agrupacion      text      denominación de la agrupación política (partido o alianza). Hay ~820 valores distintos, con variantes de texto por distrito/año para el "mismo" espacio político. Ver diccionario antes de filtrar por nombre.
- lista           text      nombre de lista interna (nula en ~24% de filas: generales sin listas internas)
- cargo           text      'DIPUTADOS NACIONALES' | 'SENADORES NACIONALES' | 'PARLAMENTARIOS DEL MERCOSUR' | 'PRESIDENTE Y VICE'
- subcategoria    text      'TITULARES' | 'SUPLENTES' | 'PRESIDENTE' | 'VICEPRESIDENTE'
- posicion        integer   posición en la lista (1 = encabeza)
- apellido        text
- nombres         text
- genero          text      'F' | 'M'
- dni             text
- fecha_nacimiento date
- id_candidato    text      identificador único de persona candidata. Usar
                             SIEMPRE que haya que distinguir o agrupar por
                             persona a través de distintas filas/elecciones
                             (ver regla en REGLAS_SQL). NO usar apellido+nombres
                             para eso: puede repetirse entre personas distintas
                             o variar en la escritura de la misma persona.

NO existen: resultados electorales, votos, quién ganó, quién resultó electo,
padrón, afiliaciones, autoridades de mesa, financiamiento, participación de
agrupaciones (vigencia de partidos, integrantes de alianzas). Si la pregunta
pide algo de esta lista, NO generar SQL: es fuera de alcance.
`.trim();

export const REGLAS_SQL = `
- Generar únicamente una sentencia SELECT, de solo lectura.
- Solo se puede referenciar v_candidaturas. No hay otras tablas ni joins posibles.
- Incluir siempre LIMIT (1000 si la pregunta no pide un número puntual).
- No usar punto y coma múltiple, comentarios SQL, ni DDL/DML de ningún tipo.
- Si la pregunta es ambigua entre "candidaturas" (filas) y "personas"
  (individuos), preferir contar personas con COUNT(DISTINCT id_candidato)
  cuando la pregunta use lenguaje de personas ("cuántas mujeres se
  postularon") y filas cuando use lenguaje de postulaciones ("cuántas
  candidaturas hubo").
- Preguntas sobre repetición o frecuencia de una misma persona a través de
  varias elecciones (ej. "qué candidatos se presentaron más veces", "quiénes
  se postularon en más de una elección"): agrupar por id_candidato, NUNCA
  por apellido+nombres. Dos personas distintas pueden compartir apellido y
  nombre, y la misma persona puede tener variantes de escritura entre
  elecciones — solo id_candidato identifica de forma confiable a la misma
  persona. Para mostrar el resultado igual conviene traer apellido y nombres
  (con MAX() o similar) junto al id_candidato y su conteo.
- Filtros por nombre de agrupación: usar ILIKE con patrón, nunca igualdad
  exacta contra un único valor (ver diccionario, sección 6). Devolver la
  columna agrupacion en el SELECT para que las variantes que matchearon
  queden visibles.
- Modo Listado (la pregunta dice "Dame el listado completo con el detalle
  de cada candidatura, no solo el total"): el SELECT tiene que traer
  exactamente estas columnas, en este orden, ni una más ni una menos salvo
  que la pregunta pida explícitamente menos campos:
    eleccion, etapa, distrito, cargo, agrupacion, subcategoria,
    posicion, apellido, nombres
  Excepción: si el resultado puede incluir etapa PASO (la pregunta filtra
  por PASO, o no filtra etapa y por lo tanto puede traer PASO), agregar
  también la columna lista inmediatamente después de agrupacion:
    eleccion, etapa, distrito, cargo, agrupacion, lista, subcategoria,
    posicion, apellido, nombres
  Esta regla de columnas fijas NO aplica al modo Totales (agregaciones con
  COUNT/GROUP BY): ahí las columnas del SELECT dependen de por qué se pide
  desglosar.
`.trim();

export const CASOS_LIMITE = `
Casos que NO son huecos de datos sino hechos del calendario electoral.
Si la pregunta cae en uno de estos, explicar el motivo en vez de devolver
una tabla vacía o inventar una respuesta:
- No hubo PASO en 2025 (ese año solo tiene Generales).
- Parlamentarios del Mercosur (Parlasur) solo existen en 2015 y 2023.
- Presidente y Vice solo en 2011, 2015, 2019 y 2023.
- Segunda vuelta solo en 2015 y 2023 (4 candidaturas cada una).
- Presidente y Vice NO tiene TITULARES/SUPLENTES ni posicion (ver diccionario,
  sección SUBCATEGORÍA): filtrar por subcategoria = 'TITULARES' AND posicion = 1
  en este cargo devuelve siempre 0 filas y NO significa que falten datos.
`.trim();

export const DICCIONARIO_TERMINOS = `
DISTRITO — alias → valor exacto en 'distrito':
  CABA / Capital / Ciudad de Buenos Aires → CAPITAL FEDERAL
  Buenos Aires / PBA / Provincia de Buenos Aires → BUENOS AIRES
  Santiago del Estero → S DEL ESTERO
  Tierra del Fuego → T DEL FUEGO
  Córdoba → CÓRDOBA (con tilde)
  Nación / nacional / todo el país → distrito = 'DISTRITO ÚNICO'
  El resto de los distritos se escriben igual que en lenguaje natural, en MAYÚSCULAS con tildes.

CARGO — alias → valor exacto en 'cargo':
  diputados → DIPUTADOS NACIONALES
  senadores → SENADORES NACIONALES
  Parlasur / parlamentario del Mercosur → PARLAMENTARIOS DEL MERCOSUR
  presidente / presidencial → PRESIDENTE Y VICE

SUBCATEGORÍA — alias → valor exacto en 'subcategoria':
  titular → TITULARES
  suplente → SUPLENTES
  "encabeza la lista" → subcategoria = 'TITULARES' AND posicion = 1 (NO es lo mismo que solo TITULARES)
  Esta regla de TITULARES/SUPLENTES/posición aplica solo a cargos legislativos
  (DIPUTADOS NACIONALES, SENADORES NACIONALES, PARLAMENTARIOS DEL MERCOSUR).
  Para cargo = 'PRESIDENTE Y VICE' el campo subcategoria NO usa TITULARES/SUPLENTES
  ni posicion: vale 'PRESIDENTE' o 'VICEPRESIDENTE' directamente.
  "encabeza la fórmula" / "candidato a presidente" → subcategoria = 'PRESIDENTE'
  "candidato a vice" → subcategoria = 'VICEPRESIDENTE'

ETAPA — alias → valor exacto en 'etapa':
  primarias / las PASO → PASO
  elección general → Generales
  balotaje / segunda vuelta / ballotage → Segunda vuelta

GÉNERO — alias → valor exacto en 'genero':
  mujeres / candidatas / femenino → F
  varones / hombres / masculino → M

PARTIDOS Y SIGLAS — usar ILIKE, nunca igualdad exacta (821 agrupaciones distintas, con variantes por distrito/año que son entidades legales distintas):
  LLA / La Libertad Avanza → agrupacion ILIKE '%LIBERTAD AVANZA%'
  FIT / Frente de Izquierda → agrupacion ILIKE '%IZQUIERDA%TRABAJADORES%'
  Juntos por el Cambio / JxC → agrupacion ILIKE '%JUNTOS POR EL CAMBIO%'
  Cambiemos → agrupacion ILIKE '%CAMBIEMOS%' (NO fusionar con Juntos por el Cambio: son etiquetas de época distintas)
  Frente de Todos / FdT → agrupacion ILIKE '%FRENTE DE TODOS%'
  Frente Renovador → agrupacion ILIKE '%FRENTE RENOVADOR%'
  PRO / Propuesta Republicana → agrupacion ILIKE '%PROPUESTA REPUBLICANA%' OR agrupacion ILIKE '%UNION PRO%' OR agrupacion ILIKE '%UNIÓN PRO%'
  UCR / radicales → agrupacion ILIKE '%UNION CIVICA RADICAL%' OR agrupacion ILIKE '%UNIÓN CÍVICA RADICAL%'
  PJ / Justicialista → agrupacion ILIKE '%JUSTICIALISTA%'
  Para cualquier sigla no listada: armar un patrón ILIKE con el nombre más largo y distintivo posible.

FUERA DE ALCANCE — no traducir, explicar el límite:
  votos, ganó, electo, resultado, escrutinio → no hay resultados electorales
  afiliados, padrón, vigencia del partido, integrantes de alianza → viven en participación, fuera del piloto
`.trim();

export function construirContextoSistema(): string {
  return [
    "Sos el traductor de lenguaje natural a SQL de un portal público de la Cámara Nacional Electoral sobre candidaturas argentinas 2011-2025.",
    "",
    ESQUEMA_VISTA,
    "",
    REGLAS_SQL,
    "",
    CASOS_LIMITE,
    "",
    DICCIONARIO_TERMINOS,
  ].join("\n");
}
