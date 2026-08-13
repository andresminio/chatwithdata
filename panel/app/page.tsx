"use client";

import { Fragment, useState } from "react";

interface RespuestaConsulta {
  respuesta: string;
  sql: string | null;
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

  const lineas = texto.split("\n").filter((l) => l.trim() !== "");
  const bloques: { tipo: "parrafo" | "lista"; lineas: string[] }[] = [];
  for (const linea of lineas) {
    const esItem = /^[-*]\s+/.test(linea.trim());
    const tipo = esItem ? "lista" : "parrafo";
    const contenido = esItem ? linea.trim().replace(/^[-*]\s+/, "") : linea.trim();
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.tipo === tipo) {
      ultimo.lineas.push(contenido);
    } else {
      bloques.push({ tipo, lineas: [contenido] });
    }
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
// uno (por ejemplo Por distrito + Por género + 2025 juntos).
const SUBFILTROS: Record<string, { label: string; instruccion: string }[]> = {
  Listado: [
    { label: "Presidente y Vice", instruccion: "Limitalo al cargo Presidente y Vice." },
    { label: "Diputados", instruccion: "Limitalo al cargo Diputados Nacionales." },
    { label: "Senadores", instruccion: "Limitalo al cargo Senadores Nacionales." },
    { label: "PASO", instruccion: "Limitalo a la etapa PASO." },
    { label: "Generales", instruccion: "Limitalo a la etapa Generales." },
    { label: "2025", instruccion: "Limitalo al año electoral 2025." },
  ],
  Totales: [
    { label: "Por distrito", instruccion: "Desglosalo por distrito." },
    { label: "Por género", instruccion: "Desglosalo por género." },
    { label: "Por cargo", instruccion: "Desglosalo por cargo." },
    { label: "PASO", instruccion: "Limitalo a la etapa PASO." },
    { label: "Generales", instruccion: "Limitalo a la etapa Generales." },
    { label: "2025", instruccion: "Limitalo al año electoral 2025." },
  ],
};

export default function Home() {
  const [pregunta, setPregunta] = useState("");
  const [nivel1Activo, setNivel1Activo] = useState<string | null>(null);
  const [subfiltrosActivos, setSubfiltrosActivos] = useState<string[]>([]);
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<RespuestaConsulta | null>(null);
  const [reportado, setReportado] = useState(false);

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

  function toggleNivel1(label: string) {
    setNivel1Activo((actual) => (actual === label ? null : label));
    setSubfiltrosActivos([]); // las opciones de nivel 2 cambian según el nivel 1
  }

  function toggleSubfiltro(label: string) {
    setSubfiltrosActivos((actuales) =>
      actuales.includes(label) ? actuales.filter((l) => l !== label) : [...actuales, label]
    );
  }

  async function consultar() {
    const base = pregunta.trim();
    if (!base) return;
    const filtro1 = NIVEL1.find((f) => f.label === nivel1Activo);
    const opciones = nivel1Activo ? SUBFILTROS[nivel1Activo] : [];
    const instrucciones = [
      ...(filtro1 ? [filtro1.instruccion] : []),
      ...opciones.filter((f) => subfiltrosActivos.includes(f.label)).map((f) => f.instruccion),
    ];
    const texto = instrucciones.length ? `${base} (${instrucciones.join(" ")})` : base;
    setCargando(true);
    setResultado(null);
    setReportado(false);
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
          SUBFILTROS[nivel1Activo].map((f) => (
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
          <pre className="sql-body">{resultado.sql}</pre>
        </details>
      )}

      {resultado?.filas && resultado.filas.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                {columnas.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resultado.filas.map((fila, i) => (
                <tr key={i}>
                  {columnas.map((c) => (
                    <td key={c} className={typeof fila[c] === "number" ? "num" : undefined}>
                      {String(fila[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
              para acotar la búsqueda.
            </div>
          )}
        </div>
      )}

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

        .chips {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 32px;
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
          text-decoration: underline;
          cursor: pointer;
        }
        .reporte-link:hover {
          color: var(--accent-2);
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
        .sql-body {
          border-top: 1px solid var(--border);
          background: #12141f;
          padding: 16px 18px;
          font-family: "SFMono-Regular", Menlo, Consolas, monospace;
          font-size: 13px;
          line-height: 1.6;
          color: #cbd2f0;
          overflow-x: auto;
          margin: 0;
          white-space: pre-wrap;
        }

        .table-card {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          overflow: auto;
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
      `}</style>
    </main>
  );
}
