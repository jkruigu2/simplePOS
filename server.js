require('dotenv').config();
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'),
      jwt = require('jsonwebtoken'), path = require('path');
const SECRET = process.env.JWT_SECRET;
if (!SECRET || !process.env.MONGODB_URI) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- models ----------
const M = (n, f = {}) => mongoose.model(n, new mongoose.Schema(
  { co: { type: String, index: true }, id: String, ...f }, { strict: false, versionKey: false, id: false }));
const Company = mongoose.model('Company', new mongoose.Schema(
  { code: { type: String, unique: true }, name: String, loc: String, motto: String, phone: String }, { versionKey: false }));
const User = M('User', { user: String, name: String, role: String, h: String });
const Cat = M('Cat'), Prod = M('Prod'), Sale = M('Sale');

// ---------- helpers ----------
const ROLES = ['admin', 'manager', 'cashier'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fail = (c, m) => { const e = new Error(m); e.status = c; throw e; };
const wrap = f => (q, s) => f(q, s).catch(e => s.status(e.status || 500).json({ error: e.message || 'Server error' }));
const tok = u => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, co: u.co, user: u.user, name: u.name, role: u.role });
const clean = (a, co) => { if (!Array.isArray(a) || a.length > 20000) fail(400, 'Bad data'); return a.filter(x => x && x.id).map(x => ({ ...x, co })); };
async function auth(q, s, n) {
  try {
    const p = jwt.verify((q.headers.authorization || '').slice(7), SECRET);
    const u = await User.findOne({ id: p.uid }).lean();   // role is read fresh on every request
    if (!u) throw 0;
    q.u = u; n();
  } catch (e) { s.status(401).json({ error: 'Please log in again' }); }
}
const need = (...r) => (q, s, n) => r.includes(q.u.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' });
const replaceAll = (Mo, co, a) => Mo.bulkWrite([
  { deleteMany: { filter: { co, id: { $nin: a.map(x => x.id) } } } },
  ...a.map(x => ({ replaceOne: { filter: { co, id: x.id }, replacement: x, upsert: true } }))]);

// ---------- auth ----------
app.post('/api/register', wrap(async (q, s) => {
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  if (!code || !user || !d.name || !d.pass || String(d.pass).length < 4) fail(400, 'Fill in all fields (password min 4 characters).');
  if (await Company.findOne({ code })) fail(409, 'That company code is already in use.');
  await Company.create({ code, name: String(d.name).trim(), loc: d.loc, motto: d.motto, phone: d.phone });
  const u = await User.create({ id: uid(), co: code, user, name: String(d.user).trim(), role: 'admin', h: await bcrypt.hash(String(d.pass), 10) });
  s.json({ token: tok(u) });
}));
app.post('/api/login', wrap(async (q, s) => {
  const d = q.body;
  const u = await User.findOne({ co: String(d.code || '').trim().toUpperCase(), user: String(d.user || '').trim().toLowerCase() });
  if (!u || !(await bcrypt.compare(String(d.pass || ''), u.h))) fail(401, 'Invalid company code, username or password.');
  s.json({ token: tok(u) });
}));

// ---------- data ----------
app.get('/api/data', auth, wrap(async (q, s) => {
  const f = { co: q.u.co }, L = m => m.find(f).select('-_id').lean();
  const [company, users, cats, prods, sales] = await Promise.all([
    Company.findOne({ code: q.u.co }).select('-_id').lean(),
    User.find(f).select('-_id -h').lean(), L(Cat), L(Prod), L(Sale)]);
  s.json({ company, users, cats, prods, sales, me: q.u.id });
}));
app.put('/api/cats', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Cat, q.u.co, clean(q.body, q.u.co)); s.json({ ok: 1 });
}));
app.put('/api/prods', auth, wrap(async (q, s) => {
  const co = q.u.co, a = clean(q.body, co);
  if (q.u.role === 'cashier') {            // cashiers may only change stock levels
    if (a.length) await Prod.bulkWrite(a.map(x => ({ updateOne: { filter: { co, id: x.id }, update: { $set: { stock: Number(x.stock) || 0 } } } })));
  } else await replaceAll(Prod, co, a);
  s.json({ ok: 1 });
}));
app.put('/api/sales', auth, wrap(async (q, s) => {   // append-only
  const co = q.u.co, a = clean(q.body, co);
  const have = new Set((await Sale.find({ co }).select('id').lean()).map(x => x.id));
  const n = a.filter(x => !have.has(x.id)).map(x => ({ ...x, by: q.u.name }));
  if (n.length) await Sale.insertMany(n);
  s.json({ ok: 1 });
}));

// ---------- users (admin only) ----------
app.post('/api/users', auth, need('admin'), wrap(async (q, s) => {
  const d = q.body, user = String(d.user || '').trim().toLowerCase();
  if (!user || !d.name || !d.pass || String(d.pass).length < 4 || !ROLES.includes(d.role)) fail(400, 'Invalid user details.');
  if (await User.findOne({ co: q.u.co, user })) fail(409, 'Username already exists.');
  s.json(pub(await User.create({ id: uid(), co: q.u.co, user, name: String(d.name).trim(), role: d.role, h: await bcrypt.hash(String(d.pass), 10) })));
}));
app.patch('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {
  if (!ROLES.includes(q.body.role)) fail(400, 'Bad role');
  await User.updateOne({ co: q.u.co, id: q.params.id }, { role: q.body.role }); s.json({ ok: 1 });
}));
app.delete('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {
  if (q.params.id === q.u.id) fail(400, 'You cannot delete yourself.');
  await User.deleteOne({ co: q.u.co, id: q.params.id }); s.json({ ok: 1 });
}));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('POS running on port ' + (process.env.PORT || 3000))))
  .catch(e => { console.error(e.message); process.exit(1); });
