/**
 * RaM store — Tap Payments backend (Cloudflare Worker)
 *
 * Endpoints:
 *   POST /checkout   → يحسب الإجمالي من الأسعار هنا (لا من المتصفح)، ينشئ Charge في Tap، ويعيد رابط صفحة الدفع
 *   GET  /verify     → يسترجع الـ Charge من Tap ويعيد حالته الحقيقية بعد عودة العميل
 *   POST /webhook    → يستقبل إشعار Tap (post.url) ويحدّث الطلب في D1 إن كانت مربوطة
 *
 * Secrets (wrangler secret put):
 *   TAP_SECRET_KEY   sk_test_... ثم sk_live_...
 * Vars (wrangler.toml):
 *   ALLOWED_ORIGIN   أصل موقع المتجر، مثل https://abu00salman.github.io
 *   SHIPPING, FREE_SHIPPING_FROM
 */

const TAP = 'https://api.tap.company/v2';

// مصدر الحقيقة للأسعار والمخزون. نفس المعرّفات الموجودة في ram-store.html
const PRODUCTS = {
  'mag15':      { name: 'شاحن مغناطيسي لاسلكي 15W',           price: 89,  stock: 12 },
  'cable-c':    { name: 'كيبل USB-C إلى USB-C مجدول',          price: 39,  stock: 40 },
  'case-clear': { name: 'جراب شفاف مقاوم للاصفرار',           price: 59,  stock: 8  },
  'buds':       { name: 'سماعات لاسلكية بعزل الضجيج',         price: 199, stock: 15 },
  'power20':    { name: 'بطارية متنقلة 20000mAh',              price: 129, stock: 20 },
  'kb':         { name: 'لوحة مفاتيح ميكانيكية 75%',           price: 349, stock: 6  },
  'mouse':      { name: 'فأرة لاسلكية صامتة',                 price: 119, stock: 18 },
  'stand':      { name: 'حامل لابتوب ألمنيوم',                price: 149, stock: 10 },
  'hub':        { name: 'موزع USB-C ‏7 في 1',                  price: 159, stock: 14 },
  'strap':      { name: 'سوار ساعة رياضي سيليكون',            price: 45,  stock: 30 },
  'gan65':      { name: 'شاحن GaN 65W بثلاثة منافذ',           price: 139, stock: 0  },
  'glass':      { name: 'حماية شاشة زجاجية بإطار تركيب',      price: 35,  stock: 50 },
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/checkout' && req.method === 'POST') return json(await createCharge(req, env), 200, cors);
      if (url.pathname === '/order'    && req.method === 'POST') return json(await transferOrder(req, env), 200, cors);
      if (url.pathname === '/verify'   && req.method === 'GET')  return json(await verify(url, env), 200, cors);
      if (url.pathname === '/webhook'  && req.method === 'POST') return json(await webhook(req, env), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, e.status || 400, cors);
    }
  },
};

/* ---------- التحقق والحساب (مشترك) ---------- */
function buildOrder(items, customer, env) {
  if (!items.length) throw err('السلة فارغة');
  if (!/^05\d{8}$/.test(customer.phone || '')) throw err('رقم الجوال غير صحيح');
  if (!/^\S+@\S+\.\S+$/.test(customer.email || '')) throw err('البريد الإلكتروني غير صحيح');
  if (!(customer.name || '').trim()) throw err('الاسم مطلوب');

  // الإجمالي يُحسب هنا فقط
  let subtotal = 0;
  const lines = items.map(({ id, qty, color }) => {
    const p = PRODUCTS[id];
    if (!p) throw err(`منتج غير معروف: ${id}`);
    qty = Math.max(1, Math.floor(Number(qty) || 0));
    if (qty > p.stock) throw err(`المتوفر من "${p.name}" هو ${p.stock} فقط`);
    subtotal += p.price * qty;
    return { id, name: p.name, price: p.price, qty, color };
  });
  const shipping = subtotal >= Number(env.FREE_SHIPPING_FROM || 250) ? 0 : Number(env.SHIPPING || 15);
  const total = subtotal + shipping;
  const order = 'RS-' + Date.now().toString(36).toUpperCase();
  return { order, lines, subtotal, shipping, total };
}

/* ---------- /order (تحويل بنكي) ---------- */
async function transferOrder(req, env) {
  const { items = [], customer = {} } = await req.json();
  const o = buildOrder(items, customer, env);
  await saveOrder(env, { order: o.order, status: 'AWAITING_TRANSFER', method: 'transfer', total: o.total, customer, lines: o.lines });
  return { order: o.order, total: o.total };
}

/* ---------- /checkout (Tap) ---------- */
async function createCharge(req, env) {
  const { items = [], customer = {}, return_url } = await req.json();
  const { order, lines, total } = buildOrder(items, customer, env);

  const [first, ...rest] = customer.name.trim().split(/\s+/);
  const body = {
    amount: total,
    currency: 'SAR',
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: `RaM store — طلب ${order}`,
    metadata: { order, items: JSON.stringify(lines.map(l => `${l.id}x${l.qty}`)), address: customer.address || '' },
    reference: { transaction: order, order },
    receipt: { email: true, sms: true },
    customer: {
      first_name: first,
      last_name: rest.join(' ') || first,
      email: customer.email,
      phone: { country_code: 966, number: Number(customer.phone.slice(1)) },
    },
    source: { id: 'src_all' },                       // يعرض كل الوسائل المفعّلة في حسابك (مدى، بطاقات، Apple Pay…)
    post: { url: `${new URL(req.url).origin}/webhook` },
    redirect: { url: return_url || env.ALLOWED_ORIGIN },
  };

  const charge = await tap(env, 'POST', '/charges', body);
  if (!charge?.transaction?.url) throw err(charge?.errors?.[0]?.description || 'لم تُنشأ عملية الدفع');

  await saveOrder(env, { order, charge_id: charge.id, status: charge.status, method: 'tap', total, customer, lines });
  return { order, url: charge.transaction.url };
}

/* ---------- /verify ---------- */
async function verify(url, env) {
  const id = url.searchParams.get('tap_id');
  if (!id || !/^chg_/.test(id)) throw err('معرّف غير صحيح');
  const c = await tap(env, 'GET', `/charges/${id}`);
  const order = c?.reference?.order || c?.metadata?.order || '';
  await saveOrder(env, { order, charge_id: c.id, status: c.status });
  return {
    status: c.status,                                  // CAPTURED = تم الدفع
    order,
    amount: c.amount,
    phone: c.customer?.phone?.number ? '0' + c.customer.phone.number : null,
    message: c.status === 'CAPTURED' ? null : (c.response?.message || 'لم تكتمل العملية'),
  };
}

/* ---------- /webhook ---------- */
async function webhook(req, env) {
  const p = await req.json();
  // لا نثق بجسم الإشعار؛ نسترجع الـ Charge من Tap مباشرة
  if (p?.id && /^chg_/.test(p.id)) {
    const c = await tap(env, 'GET', `/charges/${p.id}`);
    await saveOrder(env, { order: c?.reference?.order || '', charge_id: c.id, status: c.status });
  }
  return { ok: true };
}

/* ---------- helpers ---------- */
async function tap(env, method, path, body) {
  const r = await fetch(TAP + path, {
    method,
    headers: { Authorization: `Bearer ${env.TAP_SECRET_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw err(d?.errors?.[0]?.description || `Tap error ${r.status}`, 502);
  return d;
}

// اختياري: إذا ربطت D1 باسم DB يُحفظ الطلب، وإلا يُتجاهل بهدوء
async function saveOrder(env, o) {
  if (!env.DB || !o.order) return;
  await env.DB.prepare(
    `INSERT INTO orders (id, charge_id, method, status, total, customer, lines, updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, charge_id=COALESCE(excluded.charge_id, charge_id), updated=excluded.updated`
  ).bind(o.order, o.charge_id || null, o.method || null, o.status || 'INITIATED', o.total ?? null,
         o.customer ? JSON.stringify(o.customer) : null, o.lines ? JSON.stringify(o.lines) : null, Date.now()).run();
}

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) || allowed.includes('*') ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
const json = (d, status, h) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', ...h } });
const err = (m, status = 400) => Object.assign(new Error(m), { status });
