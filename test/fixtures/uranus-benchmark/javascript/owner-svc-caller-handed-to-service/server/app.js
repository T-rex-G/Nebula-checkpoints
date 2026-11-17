const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
const notes = require('./notes');
app.get('/notes/:id', requireAuth, async (req, res) => {
  res.json(await notes.noteFor(req.user.id, req.params.id));
});
