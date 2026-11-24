const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.put('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const invoice = await prisma.invoice.update({ where: { id: req.params.id }, data: { total: req.body.total, updatedBy: req.user.id } });
  res.json(invoice);
});
