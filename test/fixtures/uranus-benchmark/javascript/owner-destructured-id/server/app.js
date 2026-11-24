const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const { id } = req.params;
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  res.json(invoice);
});
