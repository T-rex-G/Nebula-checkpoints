const express = require('express');
const { requireAuth, requireAdmin } = require('./auth');
const app = express();
app.use(express.json());
app.get('/admin/invoices/:id', requireAuth, requireAdmin, async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  res.json(invoice);
});
