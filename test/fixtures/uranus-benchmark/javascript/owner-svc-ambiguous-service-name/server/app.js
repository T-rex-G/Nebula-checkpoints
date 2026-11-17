const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const a = require('./a');
app.get('/things/:id', requireAuth, async (req, res) => {
  res.json(await a.fetchThing(req.params.id));
});
