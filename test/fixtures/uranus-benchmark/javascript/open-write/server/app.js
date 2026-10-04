const express = require('express');
const app = express();
const Note = require('./models/note');
const passport = require('passport');
app.use(express.json());
app.post('/notes', async (req, res) => { // expect: ACC-001
  const note = await Note.create({ title: String(req.body.title) });
  res.json(note);
});
app.get('/account', passport.authenticate('session'), (req, res) => res.json(req.user));
