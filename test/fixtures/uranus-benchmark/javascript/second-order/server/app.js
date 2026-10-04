const express = require('express');
const db = require('./db');
const app = express();
app.use(express.json());
app.post('/profile', requireUser, async (req, res) => {
  await db.query('UPDATE users SET nickname = $1 WHERE id = $2', [req.body.nickname, req.user.id]);
  res.status(204).end();
});
app.get('/friends', requireUser, async (req, res) => {
  const [me] = await db.query('SELECT nickname FROM users WHERE id = $1', [req.user.id]);
  /* the stored nickname is spliced back in: second-order injection, which no trace follows through the database */
  res.json(await db.query("SELECT * FROM friends WHERE nickname = '" + me.nickname + "'")); // expect: SEC-001 to-confirm
});
function requireUser(req, res, next) { if (!req.user) return res.status(401).end(); next(); }
