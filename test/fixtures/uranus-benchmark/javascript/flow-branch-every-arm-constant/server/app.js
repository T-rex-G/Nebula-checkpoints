const express = require('express');
const app = express();
const db = require('./db');
app.get('/items', async (req, res) => {
  let order = req.query.order;
  if (order === 'desc') order = 'DESC';
  else order = 'ASC';
  res.json(await db.query('SELECT * FROM items ORDER BY name ' + order)); // known-fp: SEC-001
});
