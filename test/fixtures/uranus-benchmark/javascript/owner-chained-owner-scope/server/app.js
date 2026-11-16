const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.get('/notes/:id', requireAuth, async (req, res) => {
  const note = await knex('notes')
    .where({ id: req.params.id })
    .andWhere('user_id', req.user.id)
    .first();
  res.json(note);
});
