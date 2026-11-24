const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const users = require('./users');
app.get('/me/settings', requireAuth, async (req, res) => {
  res.json(await users.settingsOf(req.user.id));
});
