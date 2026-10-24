require('dotenv').config();
// Only needed on devices whose DNS can't look up Atlas (querySrv EBADRESP, e.g. Termux): set DNS_SERVERS=8.8.8.8,1.1.1.1 in .env
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map(x => x.trim()));
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'),
      jwt = require('jsonwebtoken'), path = require('path'), crypto = require('crypto');
const SECRET = process.env.JWT_SECRET;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- models ----------
const M = (n, f = {}) => mongoose.model(n, new mongoose.Schema(
  { co: { type: String, index: true }, id: String, ...f }, { strict: false, versionKey: false, id: false }));
const Company = mongoose.model('Company', new mongoose.Schema(
  { code: { type: String, unique: true }, name: String, loc: String, motto: String, phone: String, cur: String, rh: String }, { versionKey: false }));
const User = M('User', { user: String, name: String, role: String, h: String });
const Branch = M('Branch', { name: String, loc: String });
const Cat = M('Cat'), Prod = M('Prod'), Sale = M('Sale'), Expense = M('Expense'), Move = M('Move'), Log = M('Log'), Refund = M('Refund');
const DATA = [Cat, Prod, Sale, Expense, Move, Log, Refund];   // everything that belongs to one branch (has a `br` field)

// ---------- helpers ----------
const ROLES = ['admin', 'manager', 'cashier'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fail = (c, m) => { const e = new Error(m); e.status = c; throw e; };
const wrap = f => (q, s) => f(q, s).catch(e => s.status(e.status || 500).json({ error: e.message || 'Server error' }));
const rcode = () => [...crypto.randomBytes(12)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})(?=.)/g, '$1-');
const tok = u => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, co: u.co, user: u.user, name: u.name, role: u.role, br: u.br || [] });
// Branch access: admins see every branch; managers and cashiers only the branches assigned to them.
const scope = q => q.u.role === 'admin' ? { co: q.u.co } : { co: q.u.co, br: { $in: q.u.br || [] } };
const okBr = (q, b) => !!b && (q.u.role === 'admin' || (q.u.br || []).includes(b));
const clean = (a, q) => { if (!Array.isArray(a) || a.length > 20000) fail(400, 'Bad data'); return a.filter(x => x && x.id && okBr(q, x.br)).map(x => ({ ...x, co: q.u.co })); };
const newBranch = async (co, name, loc = '', id = uid()) => { await Branch.updateOne({ co, id }, { $setOnInsert: { co, id, name, loc } }, { upsert: true }); return { id, co, name, loc }; };
async function ensureBranch(co) {   // companies created before branches existed get one branch ("Main") that owns all their data
  if (await Branch.countDocuments({ co })) return;
  await newBranch(co, 'Main', '', 'main');
  for (const Mo of DATA) await Mo.updateMany({ co, br: { $exists: false } }, { $set: { br: 'main' } });
  await User.updateMany({ co, role: { $ne: 'admin' }, br: { $exists: false } }, { $set: { br: ['main'] } });
}
async function auth(q, s, n) {
  try {
    const p = jwt.verify((q.headers.authorization || '').slice(7), SECRET);
    const u = await User.findOne({ id: p.uid }).lean();   // role and branches are read fresh on every request
    if (!u) throw 0;
    q.u = u; n();
  } catch (e) { s.status(401).json({ error: 'Please log in again' }); }
}
const need = (...r) => (q, s, n) => r.includes(q.u.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' });
const replaceAll = (Mo, q, a) => Mo.bulkWrite([
  { deleteMany: { filter: { ...scope(q), id: { $nin: a.map(x => x.id) } } } },
  ...a.map(x => ({ replaceOne: { filter: { co: q.u.co, id: x.id }, replacement: x, upsert: true } }))]);

// ---------- health check ----------
app.get('/api/health', wrap(async (q, s) => {
  if (mongoose.connection.readyState !== 1) fail(503, 'Database not connected');
  await mongoose.connection.db.admin().ping();
  s.json({ server: 'ok', database: 'connected' });
}));

// ---------- auth ----------
app.post('/api/register', wrap(async (q, s) => {
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  if (!code || !user || !d.name || !d.pass || String(d.pass).length < 4) fail(400, 'Fill in all fields (password min 4 characters).');
  if (await Company.findOne({ code })) fail(409, 'That company code is already in use.');
  const recovery = rcode();
  await Company.create({ code, name: String(d.name).trim(), loc: d.loc, motto: d.motto, phone: d.phone, rh: await bcrypt.hash(recovery, 10) });
  await newBranch(code, 'Main', '', 'main');
  const u = await User.create({ id: uid(), co: code, user, name: String(d.user).trim(), role: 'admin', br: [], h: await bcrypt.hash(String(d.pass), 10) });
  s.json({ token: tok(u), recovery });
}));
app.post('/api/login', wrap(async (q, s) => {
  const d = q.body;
  const u = await User.findOne({ co: String(d.code || '').trim().toUpperCase(), user: String(d.user || '').trim().toLowerCase() });
  if (!u || !(await bcrypt.compare(String(d.pass || ''), u.h))) fail(401, 'Invalid company code, username or password.');
  s.json({ token: tok(u) });
}));

// ---------- data ----------
app.get('/api/data', auth, wrap(async (q, s) => {
  await ensureBranch(q.u.co);
  q.u = await User.findOne({ id: q.u.id }).lean();
  const f = scope(q), r = q.u.role, mgr = r !== 'cashier', adm = r === 'admin';
  const L = (m, lim) => { let c = m.find(f).select('-_id'); if (lim) c = c.sort({ ts: -1 }).limit(lim); return c.lean(); };
  const [company, users, branches, cats, prods, sales, expenses, rets, moves, logs] = await Promise.all([
    Company.findOne({ code: q.u.co }).select('-_id -rh').lean(), User.find({ co: q.u.co }).select('-_id -h').lean(),
    Branch.find(adm ? { co: q.u.co } : { co: q.u.co, id: { $in: q.u.br || [] } }).select('-_id').lean(),
    L(Cat), L(Prod), L(Sale), mgr ? L(Expense) : [], mgr ? L(Refund) : [], mgr ? L(Move, 500) : [], adm ? L(Log, 500) : []]);
  s.json({ company, users, branches, cats, prods, sales, expenses, rets, moves, logs, me: q.u.id });
}));
app.put('/api/cats', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Cat, q, clean(q.body, q)); s.json({ ok: 1 });
}));
app.put('/api/prods', auth, wrap(async (q, s) => {
  const co = q.u.co, a = clean(q.body, q);
  if (q.u.role === 'cashier') {            // cashiers may only change stock levels
    if (a.length) await Prod.bulkWrite(a.map(x => ({ updateOne: { filter: { ...scope(q), id: x.id }, update: { $set: { stock: Number(x.stock) || 0 } } } })));
  } else await replaceAll(Prod, q, a);
  s.json({ ok: 1 });
}));
app.put('/api/sales', auth, wrap(async (q, s) => {   // append-only
  const co = q.u.co, a = clean(q.body, q);
  const have = new Set((await Sale.find({ co, id: { $in: a.map(x => x.id) } }).select('id').lean()).map(x => x.id));
  const n = a.filter(x => !have.has(x.id)).map(x => ({ ...x, by: q.u.name }));
  if (n.length) await Sale.insertMany(n);
  s.json({ ok: 1 });
}));

const SALE_FIELDS = ['ts', 'total', 'profit', 'items', 'refs', 'refunded', 'otot'];
app.patch('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // change date
  const set = {};
  for (const k of SALE_FIELDS) if (q.body[k] !== undefined) set[k] = q.body[k];
  if ('ts' in set) { set.ts = Number(set.ts); if (!set.ts) fail(400, 'Bad date'); }
  if (!Object.keys(set).length) fail(400, 'Nothing to update');
  await Sale.updateOne({ ...scope(q), id: q.params.id }, { $set: set }); s.json({ ok: 1 });
}));
app.delete('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // delete receipt
  await Sale.deleteOne({ ...scope(q), id: q.params.id }); s.json({ ok: 1 });
}));
app.put('/api/expenses', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Expense, q, clean(q.body, q)); s.json({ ok: 1 });
}));
const append = (path, Mo, roles) => app.put(path, auth, need(...roles), wrap(async (q, s) => {   // append-only records
  const co = q.u.co, a = clean(q.body, q);
  const have = new Set((await Mo.find({ co, id: { $in: a.map(x => x.id) } }).select('id').lean()).map(x => x.id));
  const n = a.filter(x => !have.has(x.id)).map(x => ({ ...x, by: q.u.name }));
  if (n.length) await Mo.insertMany(n);
  s.json({ ok: 1 });
}));
append('/api/moves', Move, ['admin', 'manager', 'cashier']);
append('/api/logs', Log, ['admin', 'manager', 'cashier']);
append('/api/rets', Refund, ['admin', 'manager']);
app.post('/api/restore', auth, need('admin'), wrap(async (q, s) => {   // replace this company's data with a backup
  const co = q.u.co, d = q.body || {};
  const fix = a => Array.isArray(a) ? a.map(x => ({ br: 'main', ...x })) : a;   // older backups have no branches
  if (Array.isArray(d.branches) && d.branches.length) {
    await Branch.deleteMany({ co }); await Branch.insertMany(d.branches.filter(x => x && x.id).map(x => ({ ...x, co })));
  } else { await Branch.deleteMany({ co }); await newBranch(co, 'Main', '', 'main'); }
  const put = async (Mo, a) => { await Mo.deleteMany({ co }); a = fix(a); if (Array.isArray(a) && a.length) await Mo.insertMany(clean(a, q)); };
  await put(Cat, d.cats); await put(Prod, d.prods); await put(Sale, d.sales); await put(Expense, d.expenses);
  await put(Move, d.moves); await put(Log, d.logs); await put(Refund, d.rets);
  s.json({ ok: 1 });
}));

app.patch('/api/company', auth, need('admin'), wrap(async (q, s) => {   // currency symbol
  const cur = String(q.body.cur || '').trim().slice(0, 6);
  if (!cur) fail(400, 'Enter a currency symbol.');
  await Company.updateOne({ code: q.u.co }, { $set: { cur } }); s.json({ ok: 1, cur });
}));

// ---------- branches (admin only) ----------
app.post('/api/branches', auth, need('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim();
  if (!name) fail(400, 'Enter a branch name.');
  if (await Branch.findOne({ co: q.u.co, name })) fail(409, 'A branch with that name already exists.');
  s.json(await newBranch(q.u.co, name, String(q.body.loc || '').trim()));
}));
app.patch('/api/branches/:id', auth, need('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim();
  if (!name) fail(400, 'Enter a branch name.');
  await Branch.updateOne({ co: q.u.co, id: q.params.id }, { $set: { name, loc: String(q.body.loc || '').trim() } }); s.json({ ok: 1 });
}));
app.delete('/api/branches/:id', auth, need('admin'), wrap(async (q, s) => {
  const co = q.u.co, id = q.params.id;
  if ((await Branch.countDocuments({ co })) < 2) fail(400, 'You need at least one branch.');
  if ((await Prod.countDocuments({ co, br: id })) || (await Sale.countDocuments({ co, br: id }))) fail(400, 'This branch still has products or sales. Move them first.');
  await Branch.deleteOne({ co, id });
  for (const Mo of [Cat, Expense, Move, Log, Refund]) await Mo.deleteMany({ co, br: id });
  await User.updateMany({ co }, { $pull: { br: id } });
  s.json({ ok: 1 });
}));

// ---------- passwords ----------
const tries = {};
app.post('/api/reset', wrap(async (q, s) => {   // forgot password: company code + recovery code
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  const key = q.ip + code, t = tries[key] = (tries[key] || []).filter(x => Date.now() - x < 900000);
  if (t.length >= 5) fail(429, 'Too many attempts. Try again in 15 minutes.');
  t.push(Date.now());
  const c = await Company.findOne({ code }), u = await User.findOne({ co: code, user });
  if (!c || !c.rh || !u || !(await bcrypt.compare(String(d.recovery || '').trim().toUpperCase(), c.rh))) fail(401, 'Company code, username or recovery code is wrong.');
  if (String(d.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: code, id: u.id }, { h: await bcrypt.hash(String(d.pass), 10) }); s.json({ ok: 1 });
}));
app.post('/api/recovery', auth, need('admin'), wrap(async (q, s) => {
  const code = rcode(); await Company.updateOne({ code: q.u.co }, { rh: await bcrypt.hash(code, 10) }); s.json({ code });
}));
app.post('/api/password', auth, wrap(async (q, s) => {   // change my own password
  const d = q.body, u = await User.findOne({ co: q.u.co, id: q.u.id });
  if (!(await bcrypt.compare(String(d.cur || ''), u.h))) fail(401, 'Current password is wrong.');
  if (String(d.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: q.u.co, id: q.u.id }, { h: await bcrypt.hash(String(d.pass), 10) }); s.json({ ok: 1 });
}));
app.patch('/api/users/:id/password', auth, need('admin'), wrap(async (q, s) => {   // admin resets a user's password
  if (String(q.body.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: q.u.co, id: q.params.id }, { h: await bcrypt.hash(String(q.body.pass), 10) }); s.json({ ok: 1 });
}));

// ---------- users (admin only) ----------
const goodBr = async (co, a) => { const ids = (await Branch.find({ co }).select('id').lean()).map(x => x.id); return (Array.isArray(a) ? a : []).filter(x => ids.includes(x)); };
app.post('/api/users', auth, need('admin'), wrap(async (q, s) => {
  const d = q.body, user = String(d.user || '').trim().toLowerCase();
  if (!user || !d.name || !d.pass || String(d.pass).length < 4 || !ROLES.includes(d.role)) fail(400, 'Invalid user details.');
  if (await User.findOne({ co: q.u.co, user })) fail(409, 'Username already exists.');
  const br = d.role === 'admin' ? [] : await goodBr(q.u.co, d.br);
  if (d.role !== 'admin' && !br.length) fail(400, 'Choose at least one branch for this user.');
  s.json(pub(await User.create({ id: uid(), co: q.u.co, user, name: String(d.name).trim(), role: d.role, br, h: await bcrypt.hash(String(d.pass), 10) })));
}));
app.patch('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {   // change role, branches and/or password
  const set = {}, u = await User.findOne({ co: q.u.co, id: q.params.id }).lean();
  if (!u) fail(404, 'User not found.');
  if (q.body.role !== undefined) { if (!ROLES.includes(q.body.role)) fail(400, 'Bad role'); set.role = q.body.role; }
  if (q.body.br !== undefined) set.br = await goodBr(q.u.co, q.body.br);
  if ((set.role || u.role) !== 'admin' && !(set.br || u.br || []).length) set.br = [(await Branch.findOne({ co: q.u.co }).lean() || {}).id].filter(Boolean);
  if (q.body.pass !== undefined) { if (String(q.body.pass).length < 4) fail(400, 'Password must be at least 4 characters.'); set.h = await bcrypt.hash(String(q.body.pass), 10); }
  if (!Object.keys(set).length) fail(400, 'Nothing to update');
  await User.updateOne({ co: q.u.co, id: q.params.id }, { $set: set }); s.json({ ok: 1, br: set.br });
}));
app.delete('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {
  if (q.params.id === q.u.id) fail(400, 'You cannot delete yourself.');
  await User.deleteOne({ co: q.u.co, id: q.params.id }); s.json({ ok: 1 });
}));

module.exports = app;   // used by the Netlify function

if (require.main === module) {   // normal `npm start` (Render, Railway, local)
  if (!SECRET || !process.env.MONGODB_URI) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => app.listen(process.env.PORT || 3000, () => console.log('POS running on port ' + (process.env.PORT || 3000))))
    .catch(e => { console.error(e.message); process.exit(1); });
}
