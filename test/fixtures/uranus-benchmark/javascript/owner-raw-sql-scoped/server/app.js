const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  res.json(rows[0]);
});
