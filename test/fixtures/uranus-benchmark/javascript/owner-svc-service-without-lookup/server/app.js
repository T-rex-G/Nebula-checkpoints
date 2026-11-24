const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const jobs = require('./jobs');
app.post('/exports/:id/retry', requireAuth, async (req, res) => {
  await jobs.retryExport(req.params.id);
  res.status(202).end();
});
