const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const repo = require('./repo/orders');
app.delete('/orders/:orderId', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const { orderId } = req.params;
  await repo.removeOrder(orderId);
  res.status(204).end();
});
