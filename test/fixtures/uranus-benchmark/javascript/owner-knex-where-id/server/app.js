const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const invoice = await knex('invoices').where({ id: req.params.id }).first();
  res.json(invoice);
});
