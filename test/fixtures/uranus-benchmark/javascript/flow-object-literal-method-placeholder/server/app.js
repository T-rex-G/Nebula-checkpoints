const express = require('express');
const app = express();
const users = {
  find(name) { return db.query('SELECT * FROM u WHERE n = $1', [name]); }
};
app.get('/u', async (req, res) => { res.json(await users.find(req.query.name)); });
