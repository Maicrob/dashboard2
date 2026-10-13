// Sincroniza movimientos de Fintoc (solo lectura) -> Supabase. Requiere Node 18+.
const FINTOC_SECRET_KEY = process.env.FINTOC_SECRET_KEY;
const FINTOC_LINK_TOKEN = process.env.FINTOC_LINK_TOKEN;
const FINTOC_ACCOUNT_IDS = process.env.FINTOC_ACCOUNT_IDS;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SINCE_DAYS = process.env.SINCE_DAYS || "90";

const requeridos = { FINTOC_SECRET_KEY, FINTOC_LINK_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY };

for (const [k, v] of Object.entries(requeridos)) {
  if (!v) {
    console.error(`Falta el secreto: ${k}`);
    console.error("Variables detectadas en entorno:", Object.keys(process.env).filter(x => x.startsWith("FINTOC") || x.startsWith("SUPABASE")));
    process.exit(1);
  }
}

// ---- Categorías automáticas (Fintoc no las entrega). Edita a tu gusto. ----
const REGLAS = [
  ["comida",     /jumbo|lider|unimarc|santa isabel|tottus|supermerc|rappi|pedidosya|uber ?eats|restaur|cafe|mcdonald|starbucks/i],
  ["transporte", /uber|cabify|didi|metro|bip|copec|shell|petrobras|autopista|estacion/i],
  ["ocio",       /netflix|spotify|disney|hbo|youtube|cine|steam|playstation/i],
  ["salud",      /cruz verde|salcobrand|ahumada|clinica|farmacia|isapre|dental/i],
  ["cuentas",    /enel|aguas andinas|esval|vtr|entel|movistar|claro|wom|gasco|lipigas|metrogas|arriendo/i],
  ["trabajo",    /sueldo|remuneraci|honorario|pago nomina|nómina/i],
];
const categorizar = d => (REGLAS.find(([, re]) => re.test(d)) || ["otros"])[0];

const FINTOC = "https://api.fintoc.com/v1";
const fH = { Authorization: FINTOC_SECRET_KEY };

async function fintoc(path, params = {}) {
  const qs = new URLSearchParams({ link_token: FINTOC_LINK_TOKEN, ...params });
  const res = await fetch(`${FINTOC}${path}?${qs}`, { headers: fH });
  if (!res.ok) throw new Error(`Fintoc ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function cuentas() {
  if (FINTOC_ACCOUNT_IDS) return FINTOC_ACCOUNT_IDS.split(",").map(s => s.trim()).filter(Boolean);
  return (await fintoc("/accounts")).map(a => a.id);
}

async function movimientos(accountId) {
  const since = new Date(Date.now() - Number(SINCE_DAYS) * 864e5).toISOString().slice(0, 10);
  const PER = 300, todos = [];
  for (let page = 1; page <= 50; page++) {
    const lote = await fintoc(`/accounts/${accountId}/movements`, { since, per_page: PER, page });
    todos.push(...lote);
    if (lote.length < PER) break;
  }
  return todos;
}

const aFila = m => {
  const monto = Number(m.amount);
  if (!Number.isFinite(monto)) return null;
  const desc = (m.description || m.comment || "Sin descripción").toString().trim();
  return {
    fintoc_id: m.id,
    descripcion: desc,
    monto: Math.abs(monto),          // CLP no tiene decimales; si usas otra moneda, ajusta aquí
    tipo: monto >= 0 ? "Ingreso" : "Gasto",
    categoria: categorizar(desc),
    fecha: new Date(m.transaction_date || m.post_date).toISOString(),
  };
};

async function guardar(filas) {
  for (let i = 0; i < filas.length; i += 500) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/movimientos?on_conflict=fintoc_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal", // no pisa categorías que edites a mano
      },
      body: JSON.stringify(filas.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`Supabase -> ${res.status} ${await res.text()}`);
  }
}

const ids = await cuentas();
let filas = [];
for (const id of ids) {
  const movs = await movimientos(id);
  console.log(`Cuenta ${id}: ${movs.length} movimientos`);
  filas.push(...movs.map(aFila).filter(Boolean));
}
await guardar(filas);
console.log(`Listo: ${filas.length} movimientos procesados (los repetidos se ignoran).`);
