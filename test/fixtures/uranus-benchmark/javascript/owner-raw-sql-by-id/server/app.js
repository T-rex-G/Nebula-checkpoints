const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
});
