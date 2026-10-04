const express = require('express');
const app = express();
const Note = require('./models/note');
const passport = require('passport');
app.use(express.json());
app.post('/notes', passport.authenticate('session'), async (req, res) => {
  const note = await Note.create({ title: String(req.body.title), owner: req.user.id });
  res.json(note);
});
