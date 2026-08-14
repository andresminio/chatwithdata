"use client";

import { Fragment, useEffect, useRef, useState } from "react";

// Tipado mínimo de la Web Speech API: TypeScript no la incluye en sus libs
// estándar (no es parte de ningún spec W3C estable), y no vale la pena sumar
// una dependencia solo por esto. Cubre únicamente lo que usa este archivo.
interface SpeechRecognitionResultado {
  transcript: string;
}
interface SpeechRecognitionEvento {
  resultIndex: number;
  results: {
    length: number;
    item(index: number): { isFinal: boolean; 0: SpeechRecognitionResultado };
    [index: number]: { isFinal: boolean; 0: SpeechRecognitionResultado };
  };
}
interface SpeechRecognitionInstancia {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((evento: SpeechRecognitionEvento) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstancia;
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface RespuestaConsulta {
  respuesta: string;
  sql: string | null;
  explicacionSql?: string | null;
  filas: Record<string, unknown>[];
  error?: string;
  detalle?: string;
  reintentable?: boolean;
  logId?: number | null;
  truncado?: boolean;
  limite?: number;
  total?: number | null;
}

// Render liviano del markdown que devuelve el modelo: **negrita** resaltada
// con el color de acento y líneas que empiezan con "- " como lista con
// viñeta de color, en vez de mostrar los asteriscos literales.
function formatearRespuesta(texto: string) {
  const partesEnLinea = (linea: string) =>
    linea.split(/(\*\*[^*]+\*\*)/g).map((parte, i) => {
      const match = parte.match(/^\*\*([^*]+)\*\*$/);
      return match ? (
        <strong key={i} className="destacado">
          {match[1]}
        </strong>
      ) : (
        <Fragment key={i}>{parte}</Fragment>
      );
    });

  // Una línea en blanco fuerza un párrafo nuevo (en vez de seguir juntando
  // con <br/>), así el modelo puede separar ideas en párrafos distintos
  // dejando una línea vacía en el texto.
  const lineasCrudas = texto.split("\n");
  const bloques: { tipo: "parrafo" | "lista"; lineas: string[] }[] = [];
  let forzarBloqueNuevo = true;
  for (const lineaCruda of lineasCrudas) {
    const linea = lineaCruda.trim();
    if (linea === "") {
      forzarBloqueNuevo = true;
      continue;
    }
    const esItem = /^[-*]\s+/.test(linea);
    const tipo = esItem ? "lista" : "parrafo";
    const contenido = esItem ? linea.replace(/^[-*]\s+/, "") : linea;
    const ultimo = bloques[bloques.length - 1];
    if (!forzarBloqueNuevo && ultimo && ultimo.tipo === tipo) {
      ultimo.lineas.push(contenido);
    } else {
      bloques.push({ tipo, lineas: [contenido] });
    }
    forzarBloqueNuevo = false;
  }

  return bloques.map((bloque, i) =>
    bloque.tipo === "lista" ? (
      <ul key={i} className="answer-list">
        {bloque.lineas.map((l, j) => (
          <li key={j}>{partesEnLinea(l)}</li>
        ))}
      </ul>
    ) : (
      <p key={i}>
        {bloque.lineas.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {partesEnLinea(l)}
          </Fragment>
        ))}
      </p>
    )
  );
}

// Nivel 1: elige el modo de la respuesta. Excluyente entre sí (no tiene
// sentido pedir "listado" y "total agregado" al mismo tiempo).
const NIVEL1 = [
  { label: "Totales", instruccion: "Dame el total agregado (la cantidad), no el detalle fila por fila." },
  { label: "Listado", instruccion: "Dame el listado completo con el detalle de cada candidatura, no solo el total." },
];

// Nivel 2: depende de qué se eligió en el nivel 1. Se puede combinar más de
// uno (por ejemplo Por distrito + Por género + un año elegido juntos).
const ELEGIR_ANIO = "Elegir un año";
const ELEGIR_DISTRITO = "Elegir un distrito";

const SUBFILTROS: Record<string, { label: string; instruccion: string }[]> = {
  Listado: [
    { label: "Presidente y Vice", instruccion: "Limitalo al cargo Presidente y Vice." },
    { label: "Diputados", instruccion: "Limitalo al cargo Diputados Nacionales." },
    { label: "Senadores", instruccion: "Limitalo al cargo Senadores Nacionales." },
    { label: "PASO", instruccion: "Limitalo a la etapa PASO." },
    { label: "Generales", instruccion: "Limitalo a la etapa Generales." },
    { label: ELEGIR_ANIO, instruccion: "" },
    // Al final: reusa el mismo estado/filas desplegables que "Por distrito"
    // en Totales, pero acá es filtro puro (no hay "desglose" en un listado).
    { label: ELEGIR_DISTRITO, instruccion: "" },
  ],
  Totales: [
    { label: "Por distrito", instruccion: "Desglosalo por distrito." },
    { label: "Por género", instruccion: "Desglosalo por género." },
    { label: "Por cargo", instruccion: "Desglosalo por cargo." },
    { label: "Por etapa", instruccion: "" },
    { label: ELEGIR_ANIO, instruccion: "" },
  ],
};

// Segunda línea de "Por etapa" (Totales): a diferencia de año/distrito/
// género/cargo, acá se puede elegir más de una etapa a la vez (PASO y
// Generales juntas es una combinación válida, no una contradicción).
const ETAPAS = ["PASO", "Generales"];

// Años electorales disponibles y en cuáles NO hubo PASO (ver CASOS_LIMITE en
// lib/context.ts): si PASO está activo, esos años no se ofrecen para elegir,
// y viceversa, para no armar una combinación sin sentido desde el UI.
const ANIOS = ["2011", "2013", "2015", "2017", "2019", "2021", "2023", "2025"];
const ANIOS_SIN_PASO = new Set(["2025"]);

// Valores exactos de la columna distrito (ver diccionario_terminos.md,
// sección 1): 24 provincias + DISTRITO ÚNICO. Se deja afuera DISTRITO
// ÚNICO acá porque no es una provincia elegible por el usuario, es la
// categoría de Presidente y Vice / Parlasur.
// { valor: exactamente lo que tiene la columna distrito (va en la
// instrucción a la IA), etiqueta: cómo se muestra en el chip }.
const DISTRITOS = [
  { valor: "BUENOS AIRES", etiqueta: "Buenos Aires" },
  { valor: "CAPITAL FEDERAL", etiqueta: "CABA" },
  { valor: "CATAMARCA", etiqueta: "Catamarca" },
  { valor: "CHACO", etiqueta: "Chaco" },
  { valor: "CHUBUT", etiqueta: "Chubut" },
  { valor: "CÓRDOBA", etiqueta: "Córdoba" },
  { valor: "CORRIENTES", etiqueta: "Corrientes" },
  { valor: "ENTRE RÍOS", etiqueta: "Entre Ríos" },
  { valor: "FORMOSA", etiqueta: "Formosa" },
  { valor: "JUJUY", etiqueta: "Jujuy" },
  { valor: "LA PAMPA", etiqueta: "La Pampa" },
  { valor: "LA RIOJA", etiqueta: "La Rioja" },
  { valor: "MENDOZA", etiqueta: "Mendoza" },
  { valor: "MISIONES", etiqueta: "Misiones" },
  { valor: "NEUQUÉN", etiqueta: "Neuquén" },
  { valor: "RÍO NEGRO", etiqueta: "Río Negro" },
  { valor: "SALTA", etiqueta: "Salta" },
  { valor: "SAN JUAN", etiqueta: "San Juan" },
  { valor: "SAN LUIS", etiqueta: "San Luis" },
  { valor: "SANTA CRUZ", etiqueta: "Santa Cruz" },
  { valor: "SANTA FE", etiqueta: "Santa Fe" },
  { valor: "S DEL ESTERO", etiqueta: "Santiago del Estero" },
  { valor: "T DEL FUEGO", etiqueta: "Tierra del Fuego" },
  { valor: "TUCUMÁN", etiqueta: "Tucumán" },
];

const GENEROS = ["Femenino", "Masculino"];

const CARGOS = [
  { valor: "PRESIDENTE Y VICE", etiqueta: "Presidente y Vice" },
  { valor: "DIPUTADOS NACIONALES", etiqueta: "Diputados Nacionales" },
  { valor: "SENADORES NACIONALES", etiqueta: "Senadores Nacionales" },
  { valor: "PARLAMENTARIOS DEL MERCOSUR", etiqueta: "Parlamentarios del Mercosur" },
];

// La tabla en pantalla pagina de a esto (el Excel descargable siempre trae
// todas las filas juntas en una sola hoja — acá es solo para no scrollear
// una lista larguísima).
const FILAS_POR_PAGINA = 25;

export default function Home() {
  const [pregunta, setPregunta] = useState("");
  const [dictadoSoportado, setDictadoSoportado] = useState(false);
  const [escuchando, setEscuchando] = useState(false);
  const reconocimientoRef = useRef<SpeechRecognitionInstancia | null>(null);
  const preguntaAntesDeDictarRef = useRef("");
  const [nivel1Activo, setNivel1Activo] = useState<string | null>(null);
  const [subfiltrosActivos, setSubfiltrosActivos] = useState<string[]>([]);
  const [anioActivo, setAnioActivo] = useState<string | null>(null);
  const [distritoActivo, setDistritoActivo] = useState<string | null>(null);
  const [generoActivo, setGeneroActivo] = useState<string | null>(null);
  const [cargoActivo, setCargoActivo] = useState<string | null>(null);
  const [etapasActivas, setEtapasActivas] = useState<string[]>([]);
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaConsulta | null>(null);
  const [reportado, setReportado] = useState(false);
  const [paginaActual, setPaginaActual] = useState(1);

  // Dictado por voz: Web Speech API nativa del navegador, sin backend ni
  // dependencia nueva. Solo Chrome/Edge (y derivados) la traen habilitada
  // hoy — Safari es parcial y Firefox no la soporta — así que el botón de
  // micrófono se muestra únicamente si el navegador la expone.
  useEffect(() => {
    const Constructor =
      typeof window !== "undefined"
        ? window.SpeechRecognition ?? window.webkitSpeechRecognition
        : undefined;
    if (!Constructor) return;

    const reconocimiento = new Constructor();
    reconocimiento.lang = "es-AR";
    reconocimiento.continuous = true;
    reconocimiento.interimResults = true;
    reconocimientoRef.current = reconocimiento;
    setDictadoSoportado(true);

    return () => {
      reconocimiento.stop();
    };
  }, []);

  function alternarDictado() {
    const reconocimiento = reconocimientoRef.current;
    if (!reconocimiento) return;

    if (escuchando) {
      reconocimiento.stop();
      setEscuchando(false);
      return;
    }

    preguntaAntesDeDictarRef.current = pregunta;
    reconocimiento.onresult = (evento) => {
      let textoFinal = "";
      let textoParcial = "";
      for (let i = evento.resultIndex; i < evento.results.length; i++) {
        const resultado = evento.results.item(i);
        if (resultado.isFinal) {
          textoFinal += resultado[0].transcript;
        } else {
          textoParcial += resultado[0].transcript;
        }
      }
      const base = preguntaAntesDeDictarRef.current;
      const separador = base && !base.endsWith(" ") ? " " : "";
      if (textoFinal) {
        preguntaAntesDeDictarRef.current = `${base}${separador}${textoFinal}`.trim();
      }
      setPregunta(`${preguntaAntesDeDictarRef.current}${textoParcial ? " " + textoParcial : ""}`);
    };
    reconocimiento.onerror = () => setEscuchando(false);
    reconocimiento.onend = () => setEscuchando(false);

    setEscuchando(true);
    reconocimiento.start();
  }

  async function reportarProblema() {
    if (reportado || !resultado?.logId) return;
    setReportado(true); // optimista: la experiencia no debe depender de la latencia de red
    try {
      await fetch("/api/reportar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logId: resultado.logId }),
      });
    } catch {
      // si falla el request no revertimos el texto: para quien reportó ya
      // "se envió"; el caso raro de fallo de red se pierde antes que
      // confundir con un botón que vuelve atrás solo.
    }
  }

  async function descargarExcel() {
    const filas = resultado?.filas;
    if (!filas || filas.length === 0) return;

    // Archivo .xlsx real (no CSV): evita que Excel adivine mal la
    // codificación de texto y rompa tildes/ñ como "NÃ©stor".
    const XLSX = await import("xlsx");
    const hoja = XLSX.utils.json_to_sheet(filas);
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, "Resultados");
    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(libro, `candidaturas-${fecha}.xlsx`);
  }

  function toggleNivel1(label: string) {
    setNivel1Activo((actual) => (actual === label ? null : label));
    setSubfiltrosActivos([]); // las opciones de nivel 2 cambian según el nivel 1
    setAnioActivo(null);
    setDistritoActivo(null);
    setGeneroActivo(null);
    setCargoActivo(null);
    setEtapasActivas([]);
  }

  function toggleSubfiltro(label: string) {
    const seEstaDesactivando = subfiltrosActivos.includes(label);
    setSubfiltrosActivos((actuales) =>
      seEstaDesactivando ? actuales.filter((l) => l !== label) : [...actuales, label]
    );
    if (seEstaDesactivando) {
      // se ocultó la fila de opciones: no dejar una elección "fantasma"
      if (label === ELEGIR_ANIO) setAnioActivo(null);
      if (label === "Por distrito" || label === ELEGIR_DISTRITO) setDistritoActivo(null);
      if (label === "Por género") setGeneroActivo(null);
      if (label === "Por cargo") setCargoActivo(null);
      if (label === "Por etapa") setEtapasActivas([]);
    }
  }

  function elegirAnio(anio: string) {
    setAnioActivo((actual) => (actual === anio ? null : anio));
  }

  function elegirDistrito(distrito: string) {
    setDistritoActivo((actual) => (actual === distrito ? null : distrito));
  }

  function elegirGenero(genero: string) {
    setGeneroActivo((actual) => (actual === genero ? null : genero));
  }

  function elegirCargo(cargo: string) {
    setCargoActivo((actual) => (actual === cargo ? null : cargo));
  }

  function toggleEtapa(etapa: string) {
    setEtapasActivas((actuales) =>
      actuales.includes(etapa) ? actuales.filter((e) => e !== etapa) : [...actuales, etapa]
    );
  }

  // PASO/Generales viven en dos lugares distintos según el modo: en Listado
  // son chips directos (subfiltrosActivos); en Totales están anidados bajo
  // "Por etapa" (etapasActivas). Este helper unifica la consulta para la
  // lógica de años sin PASO, que es compartida por ambos modos.
  function etapaEstaActiva(etapa: string): boolean {
    return nivel1Activo === "Totales" ? etapasActivas.includes(etapa) : subfiltrosActivos.includes(etapa);
  }

  async function consultar() {
    const base = pregunta.trim();
    if (!base) return;
    const filtro1 = NIVEL1.find((f) => f.label === nivel1Activo);
    const opciones = nivel1Activo ? SUBFILTROS[nivel1Activo] : [];
    // "Por distrito", "Por género" y "Por cargo" son segmentación (desglose)
    // si no se elige un valor puntual, y pasan a ser filtro si se elige
    // uno — por eso quedan afuera del mapeo genérico y se arman a mano.
    const ETIQUETAS_CON_VALOR_ELEGIBLE = [
      ELEGIR_ANIO,
      ELEGIR_DISTRITO,
      "Por distrito",
      "Por género",
      "Por cargo",
      "Por etapa",
    ];
    const cargoEtiqueta = CARGOS.find((c) => c.valor === cargoActivo)?.etiqueta ?? cargoActivo;
    const instrucciones = [
      ...(filtro1 ? [filtro1.instruccion] : []),
      ...opciones
        .filter(
          (f) => !ETIQUETAS_CON_VALOR_ELEGIBLE.includes(f.label) && subfiltrosActivos.includes(f.label)
        )
        .map((f) => f.instruccion),
      ...(anioActivo ? [`Limitalo al año electoral ${anioActivo}.`] : []),
      // Por distrito (Totales) / Elegir un distrito (Listado): en Totales,
      // sin valor elegido es desglose; en Listado no hay desglose posible,
      // así que sin valor elegido no se agrega ninguna instrucción (el chip
      // queda "abierto" esperando que se elija una provincia).
      ...(subfiltrosActivos.includes("Por distrito") || subfiltrosActivos.includes(ELEGIR_DISTRITO)
        ? distritoActivo
          ? [`Limitalo al distrito ${distritoActivo}.`]
          : nivel1Activo === "Totales"
            ? ["Desglosalo por distrito."]
            : []
        : []),
      ...(subfiltrosActivos.includes("Por género") && generoActivo
        ? [`Limitalo al género ${generoActivo}.`]
        : subfiltrosActivos.includes("Por género") && nivel1Activo === "Totales"
          ? ["Desglosalo por género."]
          : []),
      ...(subfiltrosActivos.includes("Por cargo")
        ? [cargoActivo ? `Limitalo al cargo ${cargoEtiqueta}.` : "Desglosalo por cargo."]
        : []),
      ...(subfiltrosActivos.includes("Por etapa")
        ? etapasActivas.length > 0
          ? etapasActivas.map((e) => `Limitalo a la etapa ${e}.`)
          : ["Desglosalo por etapa."]
        : []),
    ];
    const texto = instrucciones.length ? `${base} (${instrucciones.join(" ")})` : base;
    setCargando(true);
    setResultado(null);
    setReportado(false);
    setPaginaActual(1);
    try {
      const res = await fetch("/api/consulta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pregunta: texto }),
      });
      const data = await res.json();
      setResultado(data);
    } catch (error) {
      setResultado({
        respuesta: "",
        sql: null,
        filas: [],
        error: "No pudimos conectarnos con el servicio. Verificá tu conexión e intentá nuevamente.",
        detalle: String(error),
      });
    } finally {
      setCargando(false);
    }
  }

  const columnas = resultado?.filas?.[0] ? Object.keys(resultado.filas[0]) : [];
  const totalPaginas = resultado?.filas
    ? Math.max(1, Math.ceil(resultado.filas.length / FILAS_POR_PAGINA))
    : 1;
  const filasPagina = resultado?.filas
    ? resultado.filas.slice(
        (paginaActual - 1) * FILAS_POR_PAGINA,
        paginaActual * FILAS_POR_PAGINA
      )
    : [];

  return (
    <main className="wrap">
      <span className="badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
        </svg>
        Asistente IA
      </span>

      <h1>Chateá con los datos electorales</h1>
      <p className="sub">
        Accedé a información sobre precandidaturas y candidaturas electorales nacionales de 2011 a 2025 mediante lenguaje natural.
      </p>

      <div className="search-card">
        <input
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && consultar()}
          placeholder="¿Cuántas mujeres encabezaron listas en 2025?"
        />
        {dictadoSoportado && (
          <button
            type="button"
            className={`mic-btn${escuchando ? " mic-btn-activo" : ""}`}
            onClick={alternarDictado}
            disabled={cargando}
            title={escuchando ? "Detener dictado" : "Preguntar por voz"}
            aria-label={escuchando ? "Detener dictado" : "Preguntar por voz"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 11a7 7 0 0 1-14 0M12 18v4M9 22h6" />
            </svg>
          </button>
        )}
        <button onClick={consultar} disabled={cargando}>
          {cargando ? (
            "Consultando..."
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="m21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
              </svg>
              Preguntar
            </>
          )}
        </button>
      </div>

      <div className="chips">
        {NIVEL1.filter((f) => !nivel1Activo || f.label === nivel1Activo).map((f) => (
          <button
            key={f.label}
            className={`chip${nivel1Activo === f.label ? " chip-activo" : ""}`}
            onClick={() => toggleNivel1(f.label)}
            disabled={cargando}
          >
            {f.label}
          </button>
        ))}
        {nivel1Activo &&
          SUBFILTROS[nivel1Activo]
            // Si ya se eligió un año sin PASO, no ofrecer PASO — salvo que
            // Generales también esté activo: ahí la etapa ya no es solo
            // PASO, así que el año sigue teniendo sentido (ver ANIOS_SIN_PASO).
            .filter(
              (f) =>
                !(
                  f.label === "PASO" &&
                  anioActivo &&
                  ANIOS_SIN_PASO.has(anioActivo) &&
                  !subfiltrosActivos.includes("Generales")
                )
            )
            .map((f) => (
              <button
                key={f.label}
                className={`chip${subfiltrosActivos.includes(f.label) ? " chip-activo" : ""}`}
                onClick={() => toggleSubfiltro(f.label)}
                disabled={cargando}
              >
                {f.label}
              </button>
            ))}
      </div>

      {nivel1Activo && subfiltrosActivos.includes(ELEGIR_ANIO) && (
        <div className="chips-sub-wrap">
          <span className="chips-sub-label">Elegí un año</span>
          <div className="chips chips-sub">
            {ANIOS
              // Si PASO está activo solo (sin Generales), no ofrecer años en
              // los que no hubo PASO. Si Generales también está activo, la
              // etapa ya cubre ambos casos y el año vuelve a tener sentido.
              // (En Totales, PASO/Generales viven bajo "Por etapa" — ver
              // etapaEstaActiva.)
              .filter(
                (anio) =>
                  !(etapaEstaActiva("PASO") && !etapaEstaActiva("Generales") && ANIOS_SIN_PASO.has(anio))
              )
              .map((anio) => (
                <button
                  key={anio}
                  className={`chip${anioActivo === anio ? " chip-activo" : ""}`}
                  onClick={() => elegirAnio(anio)}
                  disabled={cargando}
                >
                  {anio}
                </button>
              ))}
          </div>
        </div>
      )}

      {nivel1Activo &&
        (subfiltrosActivos.includes("Por distrito") || subfiltrosActivos.includes(ELEGIR_DISTRITO)) && (
        <div className="chips-sub-wrap">
          <span className="chips-sub-label">Elegí un distrito</span>
          <div className="chips chips-sub">
            {DISTRITOS.map((distrito) => (
              <button
                key={distrito.valor}
                className={`chip${distritoActivo === distrito.valor ? " chip-activo" : ""}`}
                onClick={() => elegirDistrito(distrito.valor)}
                disabled={cargando}
              >
                {distrito.etiqueta}
              </button>
            ))}
          </div>
        </div>
      )}

      {nivel1Activo && subfiltrosActivos.includes("Por género") && (
        <div className="chips-sub-wrap">
          <span className="chips-sub-label">Elegí un género</span>
          <div className="chips chips-sub">
            {GENEROS.map((genero) => (
              <button
                key={genero}
                className={`chip${generoActivo === genero ? " chip-activo" : ""}`}
                onClick={() => elegirGenero(genero)}
                disabled={cargando}
              >
                {genero}
              </button>
            ))}
          </div>
        </div>
      )}

      {nivel1Activo && subfiltrosActivos.includes("Por cargo") && (
        <div className="chips-sub-wrap">
          <span className="chips-sub-label">Elegí un cargo</span>
          <div className="chips chips-sub">
            {CARGOS.map((cargo) => (
              <button
                key={cargo.valor}
                className={`chip${cargoActivo === cargo.valor ? " chip-activo" : ""}`}
                onClick={() => elegirCargo(cargo.valor)}
                disabled={cargando}
              >
                {cargo.etiqueta}
              </button>
            ))}
          </div>
        </div>
      )}

      {nivel1Activo && subfiltrosActivos.includes("Por etapa") && (
        <div className="chips-sub-wrap">
          <span className="chips-sub-label">Elegí la etapa</span>
          <div className="chips chips-sub">
            {ETAPAS
              // Si ya se eligió un año sin PASO, no ofrecer PASO acá tampoco
              // (mismo criterio que en la fila de años).
              .filter((etapa) => !(etapa === "PASO" && anioActivo && ANIOS_SIN_PASO.has(anioActivo)))
              .map((etapa) => (
                <button
                  key={etapa}
                  className={`chip${etapasActivas.includes(etapa) ? " chip-activo" : ""}`}
                  onClick={() => toggleEtapa(etapa)}
                  disabled={cargando}
                >
                  {etapa}
                </button>
              ))}
          </div>
        </div>
      )}

      {resultado?.error && (
        <div className="error-card">
          <div>
            <strong>Error:</strong> {resultado.error}
          </div>
          {resultado.detalle && <div className="error-detalle">{resultado.detalle}</div>}
          {resultado.reintentable && (
            <button className="retry-btn" onClick={consultar} disabled={cargando}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {resultado?.respuesta && (
        <div className="answer-card">
          <div className="label">Respuesta</div>
          <div className="answer-text">{formatearRespuesta(resultado.respuesta)}</div>
          <div className="answer-disclaimer">
            Contenido generado con inteligencia artificial. Verificá la información antes de utilizarla.
          </div>
          {resultado.logId != null && (
            <div className="answer-reporte">
              <span key={reportado ? "gracias" : "reportar"} className="fade-in">
                {reportado ? (
                  "¡Gracias por tu aporte!"
                ) : (
                  <>
                    ¿Algo no resultó como esperabas? Reportalo presionando{" "}
                    <button type="button" className="reporte-link" onClick={reportarProblema}>
                      acá
                    </button>
                    .
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {resultado?.sql && (
        <details className="sql-card">
          <summary className="sql-header">
            <span className="left">
              <span className="icon">SQL</span>
              <span className="title">Consulta realizada por la IA</span>
            </span>
          </summary>
          {resultado.explicacionSql && (
            <p className="sql-explicacion">{resultado.explicacionSql}</p>
          )}
          <pre className="sql-body">{resultado.sql}</pre>
        </details>
      )}

      {resultado?.filas && resultado.filas.length > 0 && (
        <div className="table-card">
          <div className="table-header">
            <span className="table-header-title">
              Resultados{" "}
              <span className="table-header-count">
                ({resultado.filas.length} {resultado.filas.length === 1 ? "fila" : "filas"})
              </span>
            </span>
            <button type="button" className="download-btn" onClick={descargarExcel}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              Descargar Excel
            </button>
          </div>
          <table>
            <thead>
              <tr>
                {columnas.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filasPagina.map((fila, i) => (
                <tr key={(paginaActual - 1) * FILAS_POR_PAGINA + i}>
                  {columnas.map((c) => (
                    <td key={c} className={typeof fila[c] === "number" ? "num" : undefined}>
                      {String(fila[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {totalPaginas > 1 && (
            <div className="table-paginacion">
              <button
                type="button"
                className="pagina-btn"
                onClick={() => setPaginaActual((p) => Math.max(1, p - 1))}
                disabled={paginaActual === 1}
              >
                ← Anterior
              </button>
              <span className="pagina-info">
                Página {paginaActual} de {totalPaginas}
              </span>
              <button
                type="button"
                className="pagina-btn"
                onClick={() => setPaginaActual((p) => Math.min(totalPaginas, p + 1))}
                disabled={paginaActual === totalPaginas}
              >
                Siguiente →
              </button>
            </div>
          )}
          {resultado.truncado && (
            <div className="table-truncado">
              {resultado.total != null ? (
                <>
                  Se encontraron <strong>{resultado.total}</strong> registros en total. Mostrando
                  los primeros {resultado.limite ?? resultado.filas.length}.
                </>
              ) : (
                <>Mostrando los primeros {resultado.limite ?? resultado.filas.length} de más resultados.</>
              )}{" "}
              Para el total exacto usá el filtro <strong>Totales</strong>, o agregá más filtros
              para acotar la consulta.
            </div>
          )}
        </div>
      )}

      <footer className="site-footer">
        <div className="footer-line">
          Fuente de datos · Candidaturas y precandidaturas electorales nacionales · 2011–2025 ·
          Cámara Nacional Electoral
        </div>
        <div className="footer-line">
          ¿Tenés una consulta o sugerencia? · Escribinos a{" "}
          <a href="mailto:cnelectoral.datosabiertos@pjn.gov.ar">
            cnelectoral.datosabiertos@pjn.gov.ar
          </a>
        </div>
      </footer>

      <style jsx global>{`
        :root {
          --bg: #f6f7fb;
          --card: #ffffff;
          --ink: #1a1d29;
          --ink-soft: #5b5f73;
          --border: #e6e8f0;
          --accent: #4f46e5;
          --accent-soft: #eef0ff;
          --accent-2: #06b6a4;
          --radius: 14px;
          --shadow: 0 1px 2px rgba(16, 17, 35, 0.04), 0 8px 24px rgba(16, 17, 35, 0.06);
        }
        html,
        body {
          background: linear-gradient(180deg, #eef1fb 0%, #f6f7fb 320px);
          font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
          color: var(--ink);
          margin: 0;
        }
      `}</style>

      <style jsx>{`
        .wrap {
          max-width: 760px;
          margin: 0 auto;
          padding: 48px 24px;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          font-weight: 600;
          padding: 5px 12px;
          border-radius: 999px;
          margin-bottom: 18px;
        }
        .badge svg {
          width: 12px;
          height: 12px;
        }

        h1 {
          font-size: 30px;
          line-height: 1.15;
          margin: 0 0 10px 0;
          letter-spacing: -0.02em;
          font-weight: 700;
          background: linear-gradient(90deg, #1a1d29, #3d3fae);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .sub {
          color: var(--ink-soft);
          font-size: 15px;
          line-height: 1.5;
          margin: 0 0 32px 0;
          max-width: 560px;
        }

        .search-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          padding: 8px;
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
          transition: box-shadow 0.15s, border-color 0.15s;
        }
        .search-card:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow);
        }
        .search-card input {
          flex: 1;
          border: none;
          outline: none;
          padding: 14px 16px;
          font-size: 15px;
          color: var(--ink);
          background: transparent;
        }
        .search-card input::placeholder {
          color: #9296a8;
        }
        .search-card button {
          display: flex;
          align-items: center;
          gap: 8px;
          border: none;
          background: linear-gradient(135deg, var(--accent), #6d5ff5);
          color: white;
          font-weight: 600;
          font-size: 14px;
          padding: 0 20px;
          border-radius: 9px;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(79, 70, 229, 0.28);
        }
        .search-card button:disabled {
          opacity: 0.7;
          cursor: default;
        }
        @media (max-width: 480px) {
          .search-card {
            flex-direction: column;
          }
          .search-card input {
            font-size: 14px;
          }
          .search-card button {
            justify-content: center;
            padding: 12px 20px;
          }
        }
        .search-card button svg {
          width: 15px;
          height: 15px;
        }

        .search-card .mic-btn {
          background: var(--accent-soft);
          color: var(--accent);
          box-shadow: none;
          padding: 0 14px;
        }
        .search-card .mic-btn svg {
          width: 17px;
          height: 17px;
        }
        .search-card .mic-btn-activo {
          background: #fdeaea;
          color: #d64545;
          animation: mic-pulso 1.4s ease-in-out infinite;
        }
        @keyframes mic-pulso {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.35);
          }
          50% {
            box-shadow: 0 0 0 6px rgba(214, 69, 69, 0);
          }
        }

        .chips {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 32px;
        }
        .chips-sub-wrap {
          border-top: 1px solid var(--border);
          margin-top: -20px;
          padding-top: 14px;
          margin-bottom: 28px;
        }
        .chips-sub-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: var(--ink-soft);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 8px;
        }
        .chips-sub-wrap .chips-sub {
          margin-bottom: 0;
        }
        .chips-sub .chip {
          font-size: 11px;
          padding: 5px 11px;
        }
        .chip {
          font-size: 12px;
          color: var(--ink-soft);
          background: var(--card);
          border: 1px solid var(--border);
          padding: 6px 12px;
          border-radius: 999px;
          cursor: pointer;
        }
        .chip:hover {
          border-color: var(--accent);
          color: var(--accent);
        }
        .chip-activo {
          background: var(--accent);
          border-color: var(--accent);
          color: #fff;
          font-weight: 600;
        }
        .chip-activo:hover {
          color: #fff;
        }

        .error-card {
          background: #fee;
          border-radius: var(--radius);
          padding: 1rem;
          margin-bottom: 1rem;
          color: #900;
        }
        .error-detalle {
          font-size: 13px;
          margin-top: 0.25rem;
        }
        .retry-btn {
          margin-top: 0.6rem;
          border: 1px solid #900;
          background: transparent;
          color: #900;
          font-weight: 600;
          font-size: 12px;
          padding: 5px 14px;
          border-radius: 999px;
          cursor: pointer;
        }
        .retry-btn:hover {
          background: #900;
          color: #fff;
        }
        .retry-btn:disabled {
          opacity: 0.6;
          cursor: default;
        }

        .answer-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-left: 3px solid var(--accent-2);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          padding: 22px 24px;
          margin-bottom: 16px;
        }
        .answer-card .label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--accent-2);
          margin-bottom: 8px;
        }
        .answer-text {
          font-size: 16px;
          line-height: 1.6;
          color: var(--ink);
        }
        .answer-text p {
          margin: 0 0 12px 0;
        }
        .answer-text p:last-child {
          margin-bottom: 0;
        }
        .answer-text .destacado {
          color: var(--accent);
          font-weight: 700;
        }
        .answer-list {
          list-style: none;
          margin: 0 0 12px 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .answer-list:last-child {
          margin-bottom: 0;
        }
        .answer-list li {
          list-style: none;
          position: relative;
          padding-left: 18px;
        }
        .answer-list li::before {
          content: "";
          position: absolute;
          left: 0;
          top: 9px;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--accent-2);
        }
        .answer-disclaimer {
          margin-top: 14px;
          padding-top: 12px;
          border-top: 1px solid var(--border);
          font-size: 12px;
          color: var(--ink-soft);
        }
        .answer-reporte {
          margin-top: 6px;
          font-size: 12px;
          color: var(--ink-soft);
        }
        .reporte-link {
          border: none;
          background: none;
          padding: 0;
          font: inherit;
          color: var(--accent);
          font-weight: 600;
          text-decoration: none;
          cursor: pointer;
        }
        .reporte-link:hover {
          color: var(--accent-2);
          text-decoration: underline;
        }
        .fade-in {
          display: inline-block;
          animation: fadeIn 0.35s ease;
        }
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(2px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .sql-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          margin-bottom: 16px;
          overflow: hidden;
        }
        .sql-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          cursor: pointer;
          list-style: none;
        }
        .sql-header::-webkit-details-marker {
          display: none;
        }
        .sql-header .left {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .sql-header .icon {
          width: 26px;
          height: 26px;
          border-radius: 7px;
          background: var(--accent-soft);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
        }
        .sql-header .title {
          font-size: 14px;
          font-weight: 600;
          color: var(--ink);
        }
        .sql-explicacion {
          border-top: 1px solid var(--border);
          padding: 14px 18px;
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: var(--ink-soft);
          background: #fafaff;
        }
        .sql-body {
          background: #f4f5fb;
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 14px 16px;
          font-family: "SFMono-Regular", Menlo, Consolas, monospace;
          font-size: 13px;
          line-height: 1.6;
          color: #3d3f6b;
          overflow-x: auto;
          margin: 4px 18px 16px;
          white-space: pre-wrap;
        }

        .table-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          overflow: auto;
        }
        .table-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 18px;
          border-bottom: 1px solid var(--border);
          background: #fafaff;
        }
        .table-header-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--ink);
        }
        .table-header-count {
          font-weight: 400;
          color: var(--ink-soft);
        }
        .download-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: #fff;
          color: var(--ink);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .download-btn svg {
          width: 15px;
          height: 15px;
        }
        .download-btn:hover {
          border-color: var(--accent);
          color: var(--accent);
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        thead th {
          text-align: left;
          padding: 12px 18px;
          background: #fafaff;
          color: var(--ink-soft);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          border-bottom: 1px solid var(--border);
        }
        tbody td {
          padding: 12px 18px;
          border-bottom: 1px solid #f0f1f6;
          color: var(--ink);
          white-space: nowrap;
        }
        tbody td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        tbody tr:last-child td {
          border-bottom: none;
        }
        tbody tr:hover {
          background: #fbfbfe;
        }
        .table-paginacion {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 16px;
          padding: 10px 18px;
          border-top: 1px solid var(--border);
          background: #fafaff;
        }
        .pagina-btn {
          padding: 6px 12px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: #fff;
          color: var(--ink);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .pagina-btn:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent);
        }
        .pagina-btn:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .pagina-info {
          font-size: 12px;
          color: var(--ink-soft);
        }
        .table-truncado {
          padding: 10px 18px;
          border-top: 1px solid var(--border);
          background: #fafaff;
          color: var(--ink-soft);
          font-size: 12px;
          line-height: 1.5;
        }
        .table-truncado strong {
          color: var(--ink);
        }

        .site-footer {
          margin-top: 56px;
          padding-top: 24px;
          border-top: 1px solid var(--border);
          text-align: center;
        }
        .footer-line {
          color: var(--ink-soft);
          font-size: 12px;
          line-height: 1.8;
        }
        .site-footer a {
          color: var(--accent);
          font-weight: 600;
          text-decoration: none;
        }
        .site-footer a:hover {
          color: var(--accent-2);
          text-decoration: underline;
        }
      `}</style>
    </main>
  );
}
