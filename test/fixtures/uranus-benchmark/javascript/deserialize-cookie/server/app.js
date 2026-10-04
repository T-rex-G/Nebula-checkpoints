const express = require('express');
const app = express();
const serialize = require('node-serialize');
const cookieParser = require('cookie-parser');
app.use(cookieParser());
app.get('/profile', (req, res) => {
  const profile = serialize.unserialize(Buffer.from(req.cookies.profile, 'base64').toString()); // expect: SEC-024
  res.json(profile);
});
