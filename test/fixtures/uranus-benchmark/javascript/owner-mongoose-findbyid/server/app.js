const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/orders/:orderId', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  const order = await Order.findById(req.params.orderId);
  res.json(order);
});
