/**
 * RaM store — بوابة Geidea (Cloudflare Worker)
 *
 * Endpoints:
 *   POST /checkout      → يحسب الإجمالي من الأسعار هنا، ينشئ Session في Geidea، ويعيد sessionId
 *   GET  /verify        → يسترجع حالة الطلب من Geidea بعد اكتمال الدفع
 *   POST /webhook       → إشعار Geidea (callbackUrl) — يتحقق ويحدّث D1
 *   POST /order         → طلب تحويل بنكي (يُسجل بانتظار التحويل)
 *   GET  /track         → تتبع العميل (رقم الطلب + الجوال)
 *   GET  /admin/orders  → قائمة الطلبات (بمفتاح الإدارة)
 *   POST /admin/status  → تغيير حالة طلب (بمفتاح الإدارة)
 *
 * Secrets (Variables and secrets في لوحة Cloudflare):
 *   GEIDEA_PUBLIC_KEY   المفتاح العام (Merchant Public Key)
 *   GEIDEA_API_PASSWORD كلمة مرور الـ API — سرّية
 *   ADMIN_KEY           مفتاح لوحة الإدارة — سرّي
 * Vars:
 *   ALLOWED_ORIGIN, FREE_SHIPPING_FROM
 * Binding:
 *   DB → قاعدة D1 (جدول orders)
 */

const GEIDEA = 'https://api.ksamerchant.geidea.net';

const DELIVERY = {
  pickup:   { name: 'استلام ذاتي', fee: 0,  needAddress: false, enabled: true },
  standard: { name: 'شحن لكل المملكة', fee: 15, needAddress: true, enabled: true, freeFrom: true },
  express:  { name: 'توصيل سريع داخل جازان', fee: 20, needAddress: true, enabled: false },
};

const PRODUCTS = {
  'ip-clear':     { name: 'جراب شفاف مضاد للاصفرار', price: 59, stock: 20 },
  'ip-silk':      { name: 'جراب سيليكون بملمس حريري', price: 69, stock: 14 },
  'ip-rugged':    { name: 'جراب مدرّع بمسند خلفي', price: 89, stock: 9 },
  'mag15':        { name: 'شاحن مغناطيسي لاسلكي 15W', price: 89, stock: 12 },
  'ip-glass':     { name: 'حماية شاشة زجاجية بإطار تركيب', price: 35, stock: 50 },
  'strap':        { name: 'سوار ساعة رياضي سيليكون', price: 45, stock: 30 },
  'ipad-kb':      { name: 'غلاف آيباد بلوحة مفاتيح', price: 249, stock: 7 },
  'ipad-folio':   { name: 'غلاف آيباد ذكي بحامل ثلاثي', price: 79, stock: 16 },
  'ipad-pen':     { name: 'قلم رقمي مع رفض راحة اليد', price: 119, stock: 11 },
  'ipad-glass':   { name: 'حماية شاشة آيباد ورقية الملمس', price: 49, stock: 25 },
  'an-clear':     { name: 'جراب شفاف لسامسونج Galaxy S', price: 49, stock: 22 },
  'an-rugged':    { name: 'جراب مدرّع بحلقة إصبع', price: 79, stock: 12 },
  'cable-c':      { name: 'كيبل USB-C إلى USB-C مجدول', price: 39, stock: 40 },
  'gan65':        { name: 'شاحن GaN 65W بثلاثة منافذ', price: 139, stock: 8 },
  'power20':      { name: 'بطارية متنقلة 20000mAh', price: 129, stock: 20 },
  'tab-folio':    { name: 'غلاف تابلت سامسونج بحامل', price: 69, stock: 14 },
  'tab-kb':       { name: 'غلاف تابلت بلوحة مفاتيح ولمس', price: 199, stock: 6 },
  'tab-glass':    { name: 'حماية شاشة تابلت زجاجية', price: 39, stock: 30 },
  'stand':        { name: 'حامل ألمنيوم قابل للطي', price: 149, stock: 10 },
  'kb':           { name: 'لوحة مفاتيح ميكانيكية 75%', price: 349, stock: 6 },
  'mouse':        { name: 'فأرة لاسلكية صامتة', price: 119, stock: 18 },
  'hub':          { name: 'موزع USB-C ‏7 في 1', price: 159, stock: 14 },
  'buds':         { name: 'سماعات لاسلكية بعزل الضجيج', price: 199, stock: 15 },
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/checkout' && req.method === 'POST') return json(await createSession(req, env), 200, cors);
      if (url.pathname === '/order'    && req.method === 'POST') return json(await transferOrder(req, env), 200, cors);
      if (url.pathname === '/verify'   && req.method === 'GET')  return json(await verify(url, env), 200, cors);
      if (url.pathname === '/webhook'  && req.method === 'POST') return json(await webhook(req, env), 200, cors);
      if (url.pathname === '/notify'   && req.method === 'POST') return json(await notifyMe(req, env), 200, cors);
      if (url.pathname === '/admin/notify' && req.method === 'GET') return json(await adminNotify(req, env), 200, cors);
      if (url.pathname === '/track'    && req.method === 'GET')  return json(await track(url, env), 200, cors);
      if (url.pathname === '/admin/orders' && req.method === 'GET')  return json(await adminList(req, env), 200, cors);
      if (url.pathname === '/admin/status' && req.method === 'POST') return json(await adminStatus(req, env), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, e.status || 400, cors);
    }
  },
};

/* ---------- التحقق والحساب (مشترك) ---------- */
function buildOrder(items, customer, env, deliveryId) {
  if (!items.length) throw err('السلة فارغة');
  if (!/^05\d{8}$/.test(customer.phone || '')) throw err('رقم الجوال غير صحيح');
  if (!/^\S+@\S+\.\S+$/.test(customer.email || '')) throw err('البريد الإلكتروني غير صحيح');
  if (!(customer.name || '').trim()) throw err('الاسم مطلوب');
  const d = DELIVERY[deliveryId] && DELIVERY[deliveryId].enabled ? DELIVERY[deliveryId] : DELIVERY.standard;
  if (d.needAddress && !(customer.address || '').trim()) throw err('العنوان مطلوب لهذه الطريقة');

  let subtotal = 0;
  const lines = items.map(({ id, qty, color }) => {
    const p = PRODUCTS[id];
    if (!p) throw err(`منتج غير معروف: ${id}`);
    qty = Math.max(1, Math.floor(Number(qty) || 0));
    if (qty > p.stock) throw err(`المتوفر من "${p.name}" هو ${p.stock} فقط`);
    subtotal += p.price * qty;
    return { id, name: p.name, price: p.price, qty, color };
  });
  const shipping = d.fee === 0 ? 0 : (d.freeFrom && subtotal >= Number(env.FREE_SHIPPING_FROM || 250)) ? 0 : d.fee;
  const total = subtotal + shipping;
  const order = 'RS-' + Date.now().toString(36).toUpperCase();
  return { order, lines, subtotal, shipping, total, deliveryName: d.name };
}

/* ---------- /checkout (Geidea Session) ---------- */
async function createSession(req, env) {
  if (!env.GEIDEA_PUBLIC_KEY || !env.GEIDEA_API_PASSWORD) throw err('مفاتيح Geidea غير مضبوطة في إعدادات الـ Worker', 500);
  const { items = [], customer = {}, delivery } = await req.json();
  const { order, lines, total, deliveryName } = buildOrder(items, customer, env, delivery);
  customer.delivery = deliveryName;

  const amount = total.toFixed(2);
  const timestamp = geideaTimestamp();
  const signature = await geideaSignature(env, amount, 'SAR', order, timestamp);
  const [first, ...rest] = customer.name.trim().split(/\s+/);

  const body = {
    amount, currency: 'SAR', timestamp, merchantReferenceId: order, signature,
    paymentOperation: 'Pay', language: 'ar',
    callbackUrl: `${new URL(req.url).origin}/webhook`,
    customer: {
      email: customer.email,
      phoneNumber: customer.phone.replace(/^0/, ''),
      phonecountrycode: '+966',
      firstName: first,
      lastName: rest.join(' ') || first,
    },
    order: { items: lines.map(l => ({ merchantItemId: l.id, name: l.name, count: l.qty, price: l.price })) },
  };

  const d = await geidea(env, 'POST', '/payment-intent/api/v2/direct/session', body);
  if (d.responseCode !== '000' || !d.session?.id) throw err(d.detailedResponseMessage || 'تعذّر إنشاء جلسة الدفع', 502);

  await saveOrder(env, { order, status: 'INITIATED', method: 'geidea', total, customer, lines });
  return { order, sessionId: d.session.id };
}

/* ---------- /verify ---------- */
async function verify(url, env) {
  const orderId = url.searchParams.get('orderId');   // معرّف Geidea (GUID)
  const ref = (url.searchParams.get('order') || '').toUpperCase(); // رقمنا RS-XXXX
  let g = null;
  if (orderId && /^[0-9a-f-]{30,40}$/i.test(orderId)) {
    try { g = await geidea(env, 'GET', `/pgw/api/v2/direct/order/${orderId}`); } catch (e) { g = null; }
  }
  const o = g?.order;
  if (o) {
    const ok = isPaid(o);
    const ourRef = (o.merchantReferenceId || ref || '').toUpperCase();
    if (ourRef) await saveOrder(env, { order: ourRef, charge_id: o.orderId || orderId, status: ok ? 'CAPTURED' : 'FAILED' });
    return {
      status: ok ? 'CAPTURED' : 'FAILED',
      order: ourRef,
      amount: o.amount,
      message: ok ? null : (o.detailedStatus || o.status || 'لم تكتمل العملية'),
    };
  }
  // احتياط: الإشعار (webhook) غالبًا سبق وحدّث القاعدة
  if (ref && env.DB) {
    const r = await env.DB.prepare('SELECT id,status,total FROM orders WHERE id=?1').bind(ref).first();
    if (r) return { status: r.status, order: r.id, amount: r.total, message: r.status === 'CAPTURED' ? null : 'قيد التأكيد' };
  }
  throw err('تعذّر التحقق من العملية', 502);
}

/* ---------- /webhook (callbackUrl) ---------- */
async function webhook(req, env) {
  const p = await req.json().catch(() => ({}));
  const o = p.order || p;
  const orderId = o.orderId || o.id;
  // لا نثق بجسم الإشعار؛ نسترجع الطلب من Geidea مباشرة
  if (orderId && /^[0-9a-f-]{30,40}$/i.test(String(orderId))) {
    try {
      const g = await geidea(env, 'GET', `/pgw/api/v2/direct/order/${orderId}`);
      const go = g?.order;
      if (go?.merchantReferenceId) {
        await saveOrder(env, { order: String(go.merchantReferenceId).toUpperCase(), charge_id: orderId, status: isPaid(go) ? 'CAPTURED' : 'FAILED' });
      }
    } catch (e) { /* نتجاهل حتى لا يعيد Geidea الإرسال بلا نهاية */ }
  }
  return { ok: true };
}

function isPaid(o) {
  const s = `${o.status || ''} ${o.detailedStatus || ''}`.toLowerCase();
  return s.includes('paid') || s.includes('success') || s.includes('captured');
}

/* ---------- /order (تحويل بنكي) ---------- */
async function transferOrder(req, env) {
  const { items = [], customer = {}, delivery } = await req.json();
  const o = buildOrder(items, customer, env, delivery);
  customer.delivery = o.deliveryName;
  await saveOrder(env, { order: o.order, status: 'AWAITING_TRANSFER', method: 'transfer', total: o.total, customer, lines: o.lines });
  return { order: o.order, total: o.total };
}

/* ---------- /track (تتبع العميل) ---------- */
async function track(url, env) {
  if (!env.DB) throw err('التتبع غير متاح حاليًا', 500);
  const order = (url.searchParams.get('order') || '').trim().toUpperCase();
  const phone = (url.searchParams.get('phone') || '').trim();
  if (!/^RS-[A-Z0-9]+$/.test(order)) throw err('رقم الطلب غير صحيح');
  if (!/^05\d{8}$/.test(phone)) throw err('رقم الجوال غير صحيح');
  const r = await env.DB.prepare('SELECT * FROM orders WHERE id=?1').bind(order).first();
  if (!r) throw err('لم نجد طلبًا بهذا الرقم', 404);
  const c = r.customer ? JSON.parse(r.customer) : {};
  if ((c.phone || '') !== phone) throw err('رقم الجوال لا يطابق هذا الطلب', 403);
  return {
    order: r.id, status: r.status, method: r.method, total: r.total, updated: r.updated,
    name: (c.name || '').split(/\s+/)[0],
    lines: (r.lines ? JSON.parse(r.lines) : []).map(l => ({ name: l.name || l.id, qty: l.qty })),
  };
}

/* ---------- /notify (قائمة الانتظار) ---------- */
async function notifyMe(req, env) {
  if (!env.DB) throw err('غير متاح حاليًا', 500);
  const { email = '', product = '' } = await req.json();
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 120) throw err('البريد الإلكتروني غير صحيح');
  const p = String(product).trim().slice(0, 40) || 'general';
  await env.DB.prepare('INSERT OR IGNORE INTO notify (email, product, created) VALUES (?1, ?2, ?3)')
    .bind(e, p, Date.now()).run();
  return { ok: true };
}

async function adminNotify(req, env) {
  requireAdmin(req, env);
  if (!env.DB) throw err('قاعدة البيانات غير مربوطة', 500);
  const { results } = await env.DB.prepare('SELECT email, product, created FROM notify ORDER BY created DESC LIMIT 500').all();
  return { list: results || [] };
}

/* ---------- الإدارة ---------- */
const STATUSES = ['AWAITING_TRANSFER','INITIATED','CAPTURED','PAID','ACCEPTED','REJECTED','SHIPPED','DELIVERED','CANCELLED','FAILED'];

function requireAdmin(req, env) {
  if (!env.ADMIN_KEY) throw err('ADMIN_KEY غير مضبوط في إعدادات الـ Worker', 500);
  const k = req.headers.get('x-admin-key') || new URL(req.url).searchParams.get('key');
  if (k !== env.ADMIN_KEY) throw err('غير مصرح', 401);
}

async function adminList(req, env) {
  requireAdmin(req, env);
  if (!env.DB) throw err('قاعدة البيانات D1 غير مربوطة (binding باسم DB)', 500);
  const status = new URL(req.url).searchParams.get('status');
  const q = status
    ? env.DB.prepare('SELECT * FROM orders WHERE status=?1 ORDER BY updated DESC LIMIT 200').bind(status)
    : env.DB.prepare('SELECT * FROM orders ORDER BY updated DESC LIMIT 200');
  const { results } = await q.all();
  return { orders: (results||[]).map(r => ({ ...r,
    customer: r.customer ? JSON.parse(r.customer) : null,
    lines: r.lines ? JSON.parse(r.lines) : [] })) };
}

async function adminStatus(req, env) {
  requireAdmin(req, env);
  if (!env.DB) throw err('قاعدة البيانات D1 غير مربوطة (binding باسم DB)', 500);
  const { order, status } = await req.json();
  if (!order || !STATUSES.includes(status)) throw err('حالة غير صحيحة');
  const r = await env.DB.prepare('UPDATE orders SET status=?2, updated=?3 WHERE id=?1')
    .bind(order, status, Date.now()).run();
  if (!r.meta.changes) throw err('الطلب غير موجود', 404);
  return { ok: true, order, status };
}

/* ---------- Geidea helpers ---------- */
async function geidea(env, method, path, body) {
  const auth = btoa(`${env.GEIDEA_PUBLIC_KEY}:${env.GEIDEA_API_PASSWORD}`);
  const r = await fetch(GEIDEA + path, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw err(d?.detailedResponseMessage || d?.responseMessage || `Geidea error ${r.status}`, 502);
  return d;
}

function geideaTimestamp() {
  // بصيغة yyyy/MM/dd HH:mm:ss (UTC)
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth()+1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function geideaSignature(env, amountStr, currency, refId, timestamp) {
  // HMAC-SHA256( publicKey + amount + currency + refId + timestamp , apiPassword ) → Base64
  const data = `${env.GEIDEA_PUBLIC_KEY}${amountStr}${currency}${refId}${timestamp}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GEIDEA_API_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* ---------- عامة ---------- */
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
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  };
}
const json = (d, status, h) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', ...h } });
const err = (m, status = 400) => Object.assign(new Error(m), { status });
