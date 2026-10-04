const express = require('express');
const app = express();
const User = require('./models/user');
app.use(express.json());
app.get('/login', async (req, res) => {
  const user = await User.findOne(req.query); // expect: SEC-029
  res.json({ found: Boolean(user) });
});
