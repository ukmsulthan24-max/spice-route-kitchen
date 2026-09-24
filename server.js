const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data.json");
const DB_FILE = path.join(ROOT, "restaurant.sqlite");
const PUBLIC_DIR = path.join(ROOT, "public");
const staticCache = new Map();
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
let dataCache = null;
const STATUSES = ["awaiting_confirmation", "confirmed", "preparing", "ready", "out_for_delivery", "delivered", "cancelled"];
const id = prefix => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
const now = () => new Date().toISOString();

function seed() {
  const created = now();
  return {
    restaurant: { id: "rest_demo", name: "Spice Route Kitchen", phone: "+91 98765 43210", currency: "INR", open: true, deliveryFee: 40 },
    staff: [{ id: "staff_demo", name: "Asha (Manager)", email: "admin@spiceroute.local", password: "demo123", role: "manager" }],
    menu: [
      { id: "item_biryani", category: "Rice Bowls", name: "Chicken Biryani", description: "Aromatic basmati rice with tender chicken", price: 220, available: true },
      { id: "item_paneer", category: "Rice Bowls", name: "Paneer Biryani", description: "Fragrant rice with marinated paneer", price: 190, available: true },
      { id: "item_wrap", category: "Wraps", name: "Paneer Tikka Wrap", description: "Smoky paneer, salad and mint chutney", price: 160, available: true },
      { id: "item_coke", category: "Drinks", name: "Coke", description: "330ml chilled can", price: 60, available: true }
    ],
    customers: [{ id: "cust_demo", name: "Aarav Sharma", phone: "+91 90000 00001", address: "12 MG Road, Bengaluru", createdAt: created }],
    conversations: [{ id: "conv_demo", customerId: "cust_demo", customerName: "Aarav Sharma", phone: "+91 90000 00001", status: "open", labels: ["Order in progress"], unread: 1, lastMessageAt: created, messages: [{ id: "msg_1", direction: "inbound", text: "Hi, I want two chicken biryanis", at: created }, { id: "msg_2", direction: "outbound", text: "Sure! I can help you place that order.", at: created }] }],
    orders: [{ id: "ord_demo", number: "SRK-1001", customerId: "cust_demo", customerName: "Aarav Sharma", items: [{ menuItemId: "item_biryani", name: "Chicken Biryani", quantity: 2, unitPrice: 220 }], fulfillment: "delivery", address: "12 MG Road, Bengaluru", subtotal: 440, deliveryFee: 40, total: 480, paymentStatus: "paid", paymentMethod: "demo_card", status: "confirmed", note: "", createdAt: created, updatedAt: created }],
    audit: [{ id: id("audit"), action: "order.created", entityId: "ord_demo", at: created }]
  };
}
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS otp_requests (phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, customer_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, address TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, role TEXT);
CREATE TABLE IF NOT EXISTS menu (id TEXT PRIMARY KEY, category TEXT, name TEXT, description TEXT, price REAL, available INTEGER);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, number TEXT, customerId TEXT, customerName TEXT, items TEXT, fulfillment TEXT, address TEXT, subtotal REAL, deliveryFee REAL, total REAL, paymentStatus TEXT, paymentMethod TEXT, status TEXT, note TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, customerId TEXT, customerName TEXT, phone TEXT, status TEXT, labels TEXT, unread INTEGER, lastMessageAt TEXT, messages TEXT);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, action TEXT, entityId TEXT, at TEXT);`);
function readDb() {
  const state = db.prepare("SELECT value FROM app_state WHERE key='restaurant'").get();
  return {
    restaurant: state ? JSON.parse(state.value) : seed().restaurant,
    staff: db.prepare("SELECT * FROM staff").all(),
    menu: db.prepare("SELECT id,category,name,description,price,available FROM menu").all().map(x => ({ ...x, available: !!x.available })),
    customers: db.prepare("SELECT * FROM customers").all(),
    orders: db.prepare("SELECT * FROM orders ORDER BY rowid DESC").all().map(x => ({ ...x, items: JSON.parse(x.items) })),
    conversations: db.prepare("SELECT * FROM conversations ORDER BY rowid DESC").all().map(x => ({ ...x, labels: JSON.parse(x.labels), messages: JSON.parse(x.messages) })),
    audit: db.prepare("SELECT * FROM audit ORDER BY rowid DESC").all()
  };
}
function save(data) {
  const tx = db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO app_state(key,value) VALUES('restaurant',?)").run(JSON.stringify(data.restaurant));
    for (const table of ["staff", "menu", "customers", "orders", "conversations", "audit"]) db.exec(`DELETE FROM ${table}`);
    const staff = db.prepare("INSERT INTO staff VALUES (?,?,?,?,?)"), menu = db.prepare("INSERT INTO menu VALUES (?,?,?,?,?,?)"), customer = db.prepare("INSERT INTO customers VALUES (?,?,?,?,?)");
    data.staff.forEach(x => staff.run(x.id,x.name,x.email,x.password,x.role));
    data.menu.forEach(x => menu.run(x.id,x.category,x.name,x.description,x.price,x.available ? 1 : 0));
    data.customers.forEach(x => customer.run(x.id,x.name,x.phone,x.address || "",x.createdAt));
    const order = db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    data.orders.forEach(x => order.run(x.id,x.number,x.customerId,x.customerName,JSON.stringify(x.items),x.fulfillment,x.address,x.subtotal,x.deliveryFee,x.total,x.paymentStatus,x.paymentMethod,x.status,x.note,x.createdAt,x.updatedAt));
    const conversation = db.prepare("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?)");
    data.conversations.forEach(x => conversation.run(x.id,x.customerId,x.customerName,x.phone,x.status,JSON.stringify(x.labels || []),x.unread || 0,x.lastMessageAt,JSON.stringify(x.messages || [])));
    const audit = db.prepare("INSERT INTO audit VALUES (?,?,?,?)"); data.audit.forEach(x => audit.run(x.id,x.action,x.entityId,x.at));
  }); tx();
  dataCache = data;
}
function load() {
  if (dataCache) return dataCache;
  if (db.prepare("SELECT 1 FROM menu LIMIT 1").get()) {
    dataCache = readDb();
    return dataCache;
  }
  let data;
  if (fs.existsSync(DATA_FILE)) {
    try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (error) { throw new Error(`Could not read data.json: ${error.message}`); }
  } else data = seed();
  data.staff ||= seed().staff; data.restaurant.deliveryFee ||= 40; data.audit ||= [];
  save(data); return data;
}
function bearer(req) { const value = req.headers.authorization || ""; return value.startsWith("Bearer ") ? value.slice(7) : ""; }
function customerFromRequest(req) {
  const token = bearer(req), session = token && db.prepare("SELECT * FROM sessions WHERE token=? AND expires_at>?").get(token, Date.now());
  return session ? db.prepare("SELECT * FROM customers WHERE id=?").get(session.customer_id) : null;
}
function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Accept-Encoding" };
  if (payload.length > 1024 && String(res.req.headers["accept-encoding"] || "").includes("gzip")) {
    headers["Content-Encoding"] = "gzip";
    headers.Connection = "keep-alive";
    res.writeHead(status, headers);
    return zlib.gzip(payload, (error, compressed) => error ? res.end(payload) : res.end(compressed));
  }
  headers.Connection = "keep-alive";
  res.writeHead(status, headers);
  res.end(payload);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ""; req.on("data", chunk => { raw += chunk; if (raw.length > 1024 * 1024) reject(new Error("Request body too large")); });
    req.on("end", () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error("Request body must be valid JSON")); } });
    req.on("error", reject);
  });
}
function pathname(req) { return new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname; }
function required(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
async function sendOtpSms(phone, code) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) return false;
  const payload = new URLSearchParams({
    To: phone,
    From: TWILIO_PHONE_NUMBER,
    Body: `Your Spice Route Kitchen verification code is ${code}. It expires in 5 minutes.`
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: payload
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Could not send OTP SMS (${response.status}): ${details.slice(0, 180)}`);
  }
  return true;
}
function summary(data) {
  const open = data.orders.filter(o => !["delivered", "cancelled"].includes(o.status));
  return { openOrders: open.length, unreadMessages: data.conversations.reduce((n, c) => n + (c.unread || 0), 0), menuItems: data.menu.filter(i => i.available).length, revenue: data.orders.filter(o => o.paymentStatus === "paid").reduce((n, o) => n + o.total, 0) };
}
function report(data) {
  const paid = data.orders.filter(o => o.paymentStatus === "paid");
  const byStatus = Object.fromEntries(STATUSES.map(status => [status, data.orders.filter(o => o.status === status).length]));
  const byItem = {};
  paid.forEach(o => o.items.forEach(i => { byItem[i.name] = (byItem[i.name] || 0) + i.quantity; }));
  return { ...summary(data), totalOrders: data.orders.length, paidOrders: paid.length, averageOrderValue: paid.length ? Math.round(paid.reduce((n, o) => n + o.total, 0) / paid.length) : 0, byStatus, topItems: Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, quantity]) => ({ name, quantity })) };
}
async function api(req, res, data) {
  const p = pathname(req), method = req.method;
  if (method === "GET" && p === "/api/health") return json(res, 200, { ok: true, storage: "sqlite", time: now() });
  if (method === "GET" && p === "/api/dashboard") return json(res, 200, { restaurant: data.restaurant, summary: summary(data), orders: data.orders, conversations: data.conversations, menu: data.menu });
  if (method === "GET" && p === "/api/menu") return json(res, 200, data.menu.filter(i => i.available));
  if (method === "GET" && p === "/api/orders") return json(res, 200, data.orders);
  if (method === "GET" && p === "/api/conversations") return json(res, 200, data.conversations);
  if (method === "GET" && p === "/api/reports") return json(res, 200, report(data));
  if (method === "POST" && p === "/api/customer/auth/request-otp") {
    const input = await body(req), phone = required(input.phone, "phone").replace(/[^\d+]/g, "");
    let customer = data.customers.find(c => c.phone === phone);
    if (!customer) { customer = { id: id("cust"), name: input.name?.trim() || phone, phone, address: "", createdAt: now() }; data.customers.push(customer); save(data); }
    const code = process.env.NODE_ENV === "production" ? String(crypto.randomInt(100000, 1000000)) : "123456";
    const sentBySms = await sendOtpSms(phone, code);
    if (!sentBySms && process.env.NODE_ENV === "production") return json(res, 503, { error: "SMS service is not configured. Add Twilio credentials to the server environment." });
    db.prepare("INSERT OR REPLACE INTO otp_requests VALUES (?,?,?,0)").run(phone, code, Date.now() + 5 * 60 * 1000);
    return json(res, 200, { success: true, phone, delivery: sentBySms ? "sms" : "demo", demoOtp: sentBySms ? undefined : code, expiresIn: 300 });
  }
  if (method === "POST" && p === "/api/customer/auth/verify-otp") {
    const input = await body(req), phone = required(input.phone, "phone").replace(/[^\d+]/g, ""), code = required(input.code, "code");
    const request = db.prepare("SELECT * FROM otp_requests WHERE phone=?").get(phone);
    if (!request || request.expires_at < Date.now() || request.attempts >= 5 || request.code !== code) {
      if (request) db.prepare("UPDATE otp_requests SET attempts=attempts+1 WHERE phone=?").run(phone);
      return json(res, 401, { error: "Invalid or expired OTP" });
    }
    const customer = data.customers.find(c => c.phone === phone);
    const token = `customer-${crypto.randomBytes(24).toString("hex")}`;
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(token, customer.id, Date.now() + 30 * 24 * 60 * 60 * 1000);
    db.prepare("DELETE FROM otp_requests WHERE phone=?").run(phone);
    return json(res, 200, { token, customer });
  }
  if (method === "GET" && p === "/api/customer/me") {
    const customer = customerFromRequest(req); if (!customer) return json(res, 401, { error: "Customer login required" });
    return json(res, 200, { customer });
  }
  if (method === "GET" && p === "/api/customer/orders") {
    const customer = customerFromRequest(req); if (!customer) return json(res, 401, { error: "Customer login required" });
    return json(res, 200, data.orders.filter(o => o.customerId === customer.id));
  }
  if (method === "POST" && p === "/api/customer/logout") {
    const token = bearer(req); if (token) db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return json(res, 200, { success: true });
  }
  if (method === "POST" && p === "/api/auth/login") {
    const input = await body(req), email = required(input.email, "email"), password = required(input.password, "password");
    const staff = data.staff.find(s => s.email.toLowerCase() === email.toLowerCase() && s.password === password);
    if (!staff) return json(res, 401, { error: "Invalid email or password" });
    return json(res, 200, { token: `local-${staff.id}`, staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role } });
  }
  if (method === "POST" && p === "/api/messages") {
    const input = await body(req), phone = required(input.phone, "phone"), text = required(input.text, "text");
    let customer = data.customers.find(c => c.phone === phone);
    if (!customer) { customer = { id: id("cust"), name: input.name?.trim() || phone, phone, address: "", createdAt: now() }; data.customers.push(customer); }
    let conversation = data.conversations.find(c => c.customerId === customer.id && c.status === "open");
    if (!conversation) { conversation = { id: id("conv"), customerId: customer.id, customerName: customer.name, phone, status: "open", labels: ["New inquiry"], unread: 0, lastMessageAt: now(), messages: [] }; data.conversations.unshift(conversation); }
    conversation.messages.push({ id: id("msg"), direction: "inbound", text, at: now() }); conversation.unread++; conversation.lastMessageAt = now(); save(data); return json(res, 201, conversation);
  }
  if (method === "POST" && p === "/api/orders") {
    const input = await body(req);
    const loggedInCustomer = customerFromRequest(req);
    if (!loggedInCustomer) return json(res, 401, { error: "Customer login required before checkout" });
    if (!Array.isArray(input.items) || !input.items.length) throw new Error("At least one item is required");
    const items = input.items.map(i => { const m = data.menu.find(x => x.id === i.menuItemId && x.available); if (!m) throw new Error(`Menu item is unavailable: ${i.menuItemId}`); const quantity = Math.max(1, Math.min(99, Math.floor(Number(i.quantity || 1)))); return { menuItemId: m.id, name: m.name, quantity, unitPrice: m.price }; });
    const customerName = loggedInCustomer.name, phone = loggedInCustomer.phone;
    const customer = loggedInCustomer;
    if (input.customerName?.trim() && input.customerName.trim() !== customer.name) customer.name = input.customerName.trim();
    if (input.address) customer.address = input.address;
    const fulfillment = input.fulfillment === "pickup" ? "pickup" : "delivery", subtotal = items.reduce((n, i) => n + i.quantity * i.unitPrice, 0), deliveryFee = fulfillment === "pickup" ? 0 : data.restaurant.deliveryFee;
    const order = { id: id("ord"), number: `SRK-${1000 + data.orders.length + 1}`, customerId: customer.id, customerName, items, fulfillment, address: input.address || customer.address || "", subtotal, deliveryFee, total: subtotal + deliveryFee, paymentStatus: "pending", paymentMethod: null, status: "awaiting_confirmation", note: input.note || "", createdAt: now(), updatedAt: now() };
    data.orders.unshift(order); data.audit.push({ id: id("audit"), action: "order.created", entityId: order.id, at: now() }); save(data); return json(res, 201, order);
  }
  const payment = p.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (method === "POST" && payment) { const order = data.orders.find(o => o.id === payment[1]); if (!order) return json(res, 404, { error: "Order not found" }); const input = await body(req); if (!["demo_card", "cash"].includes(input.method)) throw new Error("Use demo_card or cash"); order.paymentStatus = input.method === "cash" ? "pending" : "paid"; order.paymentMethod = input.method; order.updatedAt = now(); data.audit.push({ id: id("audit"), action: "payment.completed", entityId: order.id, at: now() }); save(data); return json(res, 200, { success: true, order }); }
  const menuMatch = p.match(/^\/api\/menu(?:\/([^/]+))?$/);
  if (method === "POST" && p === "/api/menu") { const input = await body(req), name = required(input.name, "name"), price = Number(input.price); if (!Number.isFinite(price) || price < 0) throw new Error("price must be a positive number"); const item = { id: id("item"), category: input.category?.trim() || "Other", name, description: input.description?.trim() || "", price, available: input.available !== false }; data.menu.push(item); save(data); return json(res, 201, item); }
  if (method === "PATCH" && menuMatch && menuMatch[1]) { const item = data.menu.find(i => i.id === menuMatch[1]); if (!item) return json(res, 404, { error: "Menu item not found" }); const input = await body(req); Object.assign(item, { ...(input.name ? { name: input.name.trim() } : {}), ...(input.category ? { category: input.category.trim() } : {}), ...(input.description !== undefined ? { description: String(input.description) } : {}), ...(input.price !== undefined ? { price: Number(input.price) } : {}), ...(input.available !== undefined ? { available: Boolean(input.available) } : {}) }); save(data); return json(res, 200, item); }
  const orderMatch = p.match(/^\/api\/orders\/([^/]+)\/(status|payment)$/);
  if (method === "PATCH" && orderMatch) { const order = data.orders.find(o => o.id === orderMatch[1]); if (!order) return json(res, 404, { error: "Order not found" }); const input = await body(req); if (orderMatch[2] === "status") { if (!STATUSES.includes(input.status)) throw new Error("Invalid order status"); order.status = input.status; } else { if (!["pending", "paid", "failed", "refunded"].includes(input.paymentStatus)) throw new Error("Invalid payment status"); order.paymentStatus = input.paymentStatus; } order.updatedAt = now(); data.audit.push({ id: id("audit"), action: `order.${orderMatch[2]}`, entityId: order.id, at: now() }); save(data); return json(res, 200, order); }
  const conversationMatch = p.match(/^\/api\/conversations\/([^/]+)\/(reply|read)$/);
  if (method === "POST" && conversationMatch) { const conversation = data.conversations.find(c => c.id === conversationMatch[1]); if (!conversation) return json(res, 404, { error: "Conversation not found" }); if (conversationMatch[2] === "read") conversation.unread = 0; else { const input = await body(req); conversation.messages.push({ id: id("msg"), direction: "outbound", text: required(input.text, "text"), at: now() }); conversation.lastMessageAt = now(); conversation.unread = 0; } save(data); return json(res, 200, conversation); }
  return json(res, 404, { error: "Route not found" });
}
function staticFile(req, res) {
  const requested = pathname(req) === "/" ? "/index.html" : pathname(req), file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  const cached = staticCache.get(file);
  const send = content => {
    const ext = path.extname(file), type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : "application/javascript";
    const etag = `"${crypto.createHash("sha1").update(content).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600", ETag: etag });
    res.end(content);
  };
  if (cached) return send(cached);
  fs.readFile(file, (error, content) => { if (error) return json(res, 404, { error: "Page not found" }); staticCache.set(file, content); send(content); });
}
const server = http.createServer(async (req, res) => { try { const data = load(); if (pathname(req).startsWith("/api/")) await api(req, res, data); else if (req.method === "GET") staticFile(req, res); else json(res, 405, { error: "Method not allowed" }); } catch (error) { json(res, 400, { error: error.message }); } });
server.listen(PORT, () => console.log(`Restaurant WhatsApp app running at http://localhost:${PORT}`));
