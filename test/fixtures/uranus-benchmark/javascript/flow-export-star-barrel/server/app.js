import express from 'express';
const app = express();
import { render } from './views/index.js';
app.get('/v', (req, res) => { render(res, req.query.title); });
