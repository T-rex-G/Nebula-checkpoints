const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.delete('/invoices/:id', requireAuth, async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!canAccess(req.user, invoice)) return res.status(403).end();
  await prisma.invoice.delete({ where: { id: invoice.id } });
  res.status(204).end();
});
