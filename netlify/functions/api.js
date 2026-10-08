const serverless = require('serverless-http');
const mongoose = require('mongoose');
const app = require('../../server');
const run = serverless(app);

let conn;   // reuse the database connection between requests
const connect = () => conn || (conn = mongoose
  .connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })   // fail fast instead of hanging
  .catch(e => { conn = null; throw e; }));

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try { await connect(); }
  catch (e) {
    return { statusCode: 503, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: 'Database connection failed: ' + e.message }) };
  }
  event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '/api');
  return run(event, context);
};
