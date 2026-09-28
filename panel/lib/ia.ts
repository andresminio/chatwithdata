/**
 * Llamadas a Gemini con rotación de modelos.
 *
 * Estrategia:
 *   - Lista de modelos en orden de preferencia (MODELOS, abajo).
 *   - Para cada modelo: hasta INTENTOS_POR_MODELO intentos, con ESPERA_MS fija
 *     entre uno y otro.
 *   - 404 (modelo discontinuado o inexistente): no se reintenta ese modelo,
 *     se pasa directo al siguiente.
 *   - 429 / 500 / 503 (cuota, error interno, alta demanda): se reintenta; si
 *     se agotan los intentos, se rota al siguiente modelo. Otro modelo es otro
 *     pool de capacidad en Google, así que insistir con el mismo sirve poco.
 *   - Cualquier otro error (400, respuesta que no respeta el esquema, etc.)
 *     no es de disponibilidad: se tira de inmediato, sin rotar.
 *   - Si se agotan TODOS los modelos, se tira ErrorIaNoDisponible.
 *
 * Los reintentos propios del SDK se desactivan (maxRetries: 0): de lo
 * contrario cada "intento" de acá serían en realidad 3 llamadas.
 */

// Orden de preferencia. Se puede cambiar sin tocar código con la variable de
// entorno GEMINI_MODELS (separados por coma). Por compatibilidad, si solo
// está definida GEMINI_MODEL, ese modelo va primero y el resto sigue igual.
//
// Por qué estos dos: gemini-3.5-flash-lite tiene la cuota gratuita más amplia
// (15 RPM / 500 RPD); gemini-3.6-flash es un Flash completo (mejor calidad,
// pero 5 RPM / 20 RPD) y queda solo de respaldo. gemini-flash-latest se sacó
// de la lista porque en la práctica estaba siempre saturado.
const MODELOS_POR_DEFECTO = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];

export const MODELOS: string[] = (() => {
  const lista = process.env.GEMINI_MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  if (lista?.length) return lista;
  const principal = process.env.GEMINI_MODEL?.trim();
  if (principal) return [principal, ...MODELOS_POR_DEFECTO.filter((m) => m !== principal)];
  return MODELOS_POR_DEFECTO;
})();

const INTENTOS_POR_MODELO = 2;
const ESPERA_MS = 5000;
const CODIGOS_REINTENTABLES = new Set([429, 500, 503]);

/** Se agotaron todos los modelos de la lista por errores de disponibilidad. */
export class ErrorIaNoDisponible extends Error {
  /** true si todos los fallos fueron por cuota (429). */
  readonly soloCuota: boolean;
  readonly fallos: string[];

  constructor(fallos: string[], soloCuota: boolean) {
    super(`IA no disponible, se agotaron todos los modelos. ${fallos.join(" | ")}`);
    this.name = "ErrorIaNoDisponible";
    this.fallos = fallos;
    this.soloCuota = soloCuota;
  }
}

/**
 * Código HTTP de un error del SDK. Se lee por duck typing (statusCode) para
 * no depender de importar las clases de error del SDK. Si igual llega un
 * RetryError, se mira su último error.
 */
function codigoHttp(error: unknown): number | null {
  const e = error as { statusCode?: unknown; lastError?: unknown } | null;
  if (e && typeof e.statusCode === "number") return e.statusCode;
  if (e && e.lastError) return codigoHttp(e.lastError);
  const match = String(error).match(/\b(404|429|500|503)\b/);
  return match ? Number(match[1]) : null;
}

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Ejecuta `llamada` con el primer modelo de MODELOS que responda.
 * `llamada` recibe el nombre del modelo y tiene que pasar `maxRetries: 0`
 * al SDK.
 */
export async function conRotacionDeModelos<T>(llamada: (modelo: string) => Promise<T>): Promise<T> {
  const fallos: string[] = [];
  let soloCuota = true;

  for (const modelo of MODELOS) {
    for (let intento = 1; intento <= INTENTOS_POR_MODELO; intento++) {
      try {
        return await llamada(modelo);
      } catch (error) {
        const codigo = codigoHttp(error);

        if (codigo === 404) {
          fallos.push(`${modelo}: 404 (modelo no disponible)`);
          soloCuota = false;
          break; // no se reintenta: siguiente modelo
        }

        if (codigo == null || !CODIGOS_REINTENTABLES.has(codigo)) {
          throw error; // no es un problema de disponibilidad
        }

        fallos.push(`${modelo} intento ${intento}: ${codigo}`);
        if (codigo !== 429) soloCuota = false;
        console.warn(`Gemini ${modelo} respondió ${codigo} (intento ${intento}/${INTENTOS_POR_MODELO})`);

        if (intento < INTENTOS_POR_MODELO) await esperar(ESPERA_MS);
      }
    }
  }

  throw new ErrorIaNoDisponible(fallos, soloCuota);
}
