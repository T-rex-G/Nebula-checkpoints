const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.patch('/notes/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const note = await Note.findByIdAndUpdate(req.params.id, { $set: { text: req.body.text, editedBy: req.user.id } });
  res.json(note);
});
