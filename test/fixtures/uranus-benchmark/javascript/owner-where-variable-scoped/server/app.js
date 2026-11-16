const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.get('/notes/:id', requireAuth, async (req, res) => {
  const where = { _id: req.params.id, owner: req.user.id };
  const note = await Note.findOne(where);
  res.json(note);
});
