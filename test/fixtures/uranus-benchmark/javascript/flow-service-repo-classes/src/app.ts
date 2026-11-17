import express from 'express';
const app = express();
import { OrderService } from './orders/service';
const orders = new OrderService();
app.get('/o', async (req, res) => { res.json(await orders.search(String(req.query.q))); });
