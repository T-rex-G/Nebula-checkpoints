const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/invoices/:id', requireAuth, async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice || invoice.ownerId !== req.user.id) return res.status(404).end();
  res.json(invoice);
});
