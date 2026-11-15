const express = require('express');
const app = express();
const db = require('./db');
function sanitizeInput(value) {
  return String(value).trim();
}
app.get('/users', async (req, res) => {
  const name = sanitizeInput(req.query.name);
  res.json(await db.query("SELECT * FROM users WHERE name = '" + name + "'")); // expect: SEC-001 to-confirm
});
