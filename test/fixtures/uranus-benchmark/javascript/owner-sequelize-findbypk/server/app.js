const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/documents/:id', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const doc = await Document.findByPk(req.params.id);
  if (!doc) return res.status(404).end();
  res.json(doc);
});
