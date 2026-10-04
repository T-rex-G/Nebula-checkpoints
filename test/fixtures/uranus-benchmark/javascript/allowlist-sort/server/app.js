const express = require('express');
const app = express();
const db = require('./db');
const COLUMNS = ['name', 'created_at'];
app.get('/items', async (req, res) => {
  const sort = req.query.sort;
  if (!COLUMNS.includes(sort)) return res.status(400).end();
  res.json(await db.query(`SELECT * FROM items ORDER BY ${sort}`));
});
