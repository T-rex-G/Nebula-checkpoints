import express from 'express';
const app = express();
import { lookup } from './data/index.js';
app.get('/v', async (req, res) => { res.json(await lookup(req.query.id)); });
