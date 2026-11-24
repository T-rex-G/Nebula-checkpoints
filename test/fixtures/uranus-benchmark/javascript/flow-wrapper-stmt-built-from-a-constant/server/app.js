const express = require('express');
const app = express();
const { query } = require('./db');
const TABLE = 'users';
app.get('/u', async (req, res) => { res.json(await query(`SELECT * FROM ${TABLE} WHERE n = $1`, [req.query.name])); });
