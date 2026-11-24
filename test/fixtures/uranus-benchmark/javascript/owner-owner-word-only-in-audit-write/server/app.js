const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.delete('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  await prisma.invoice.delete({ where: { id: req.params.id } });
  await prisma.audit.create({ data: { action: 'delete', userId: req.user.id } });
  res.status(204).end();
});
