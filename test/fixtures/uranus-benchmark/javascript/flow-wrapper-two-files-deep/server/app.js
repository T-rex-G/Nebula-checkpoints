const express = require('express');
const app = express();
const users = require('./users');
app.get('/u', async (req, res) => { res.json(await users.byName(req.query.name)); });
