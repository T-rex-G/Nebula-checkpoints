const express = require('express');
const app = express();
const UserService = require('./services/users');
const svc = new UserService();
app.get('/u', async (req, res) => { res.json(await svc.find(req.query.name)); });
