const express = require('express');
const app = express();
const db = require('./db');
app.get('/items', async (req, res) => {
  let name = req.query.name;
  if (!name) name = 'all';
  res.json(await db.query("SELECT * FROM items WHERE name = '" + name + "'")); // expect: SEC-001 confirmed
});
