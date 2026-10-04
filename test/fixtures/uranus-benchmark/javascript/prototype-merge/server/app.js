const express = require('express');
const app = express();
const _ = require('lodash');
const settings = {};
app.use(express.json());
app.put('/settings', requireUser, (req, res) => {
  _.merge(settings, req.body); // expect: SEC-027
  res.json(settings);
});
function requireUser(req, res, next) { if (!req.user) return res.status(401).end(); next(); }
