const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.get('/notes/:id', requireAuth, async (req, res) => {
  const note = await Note.findById(req.params.id);
  const mine = note && String(note.owner) === req.user.id;
  res.status(mine ? 200 : 404).json(mine ? note : null);
});
