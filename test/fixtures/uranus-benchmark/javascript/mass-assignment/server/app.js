const express = require('express');
const app = express();
const User = require('./models/user');
const passport = require('passport');
app.use(express.json());
app.post('/signup', async (req, res) => {
  res.json(await User.create(req.body)); // expect: SEC-028 to-confirm
});
app.get('/me', passport.authenticate('session'), (req, res) => res.json(req.user));
