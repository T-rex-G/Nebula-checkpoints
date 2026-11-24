const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const invoices = require('./services/invoices');
app.get('/invoices/:id', requireAuth, async (req, res) => {
  res.json(await invoices.getChecked(req.params.id, req.user));
});
