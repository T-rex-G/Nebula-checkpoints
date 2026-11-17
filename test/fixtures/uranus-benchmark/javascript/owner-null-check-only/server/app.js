const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.get('/notes/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const note = await Note.findById(req.params.id);
  if (note === null) return res.status(404).end();
  res.json(note);
});
