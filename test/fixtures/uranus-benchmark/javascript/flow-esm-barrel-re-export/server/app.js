import express from 'express';
import { find } from './services/index.js';
const app = express();
app.get('/u', async (req, res) => { res.json(await find(req.query.name)); });
