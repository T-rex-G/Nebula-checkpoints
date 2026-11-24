const express = require('express');
const app = express();
const db = require('./db');
app.get('/items', async (req, res) => {
  const query = { label: 'Search' };
  query.term = req.query.term;
  res.json(await db.query("SELECT * FROM items WHERE label = '" + query.label + "'")); // known-fp: SEC-001
});
