const express = require('express');
const app = express();
const users = require('./services/users');
app.get('/u', async (req, res) => { res.json(await users.find(Number(req.query.id))); });
