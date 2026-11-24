const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => {
  const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  if (!invoice) return res.status(404).end();
  res.json(invoice);
});
