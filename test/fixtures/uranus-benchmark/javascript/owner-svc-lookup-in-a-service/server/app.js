const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
const invoices = require('./invoices');
app.get('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  res.json(await invoices.byId(req.params.id));
});
