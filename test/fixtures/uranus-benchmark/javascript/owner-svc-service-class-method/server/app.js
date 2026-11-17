const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const { InvoiceService } = require('./services/invoices');
const invoices = new InvoiceService();
app.get('/invoices/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  res.json(await invoices.getInvoice(req.params.id));
});
