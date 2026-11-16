const express = require('express');
const app = express();
const store = require('./store');
app.get('/u', async (req, res) => { res.json(await store.find(req.query.name)); });
