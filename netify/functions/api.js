const serverless = require('serverless-http');
const mongoose = require('mongoose');
const app = require('../../server');
const run = serverless(app);

let conn;   // reuse the database connection between requests
const connect = () => conn || (conn = mongoose.connect(process.env.MONGODB_URI));

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await connect();
  event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '/api');
  return run(event, context);
};
