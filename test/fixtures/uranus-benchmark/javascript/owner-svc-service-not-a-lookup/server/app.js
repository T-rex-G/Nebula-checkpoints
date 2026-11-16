const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const mail = require('./mail');
app.post('/invoices/:id/remind', requireAuth, async (req, res) => {
  const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, ownerId: req.user.id } });
  await mail.sendReminder(req.params.id);
  res.status(202).end();
});
