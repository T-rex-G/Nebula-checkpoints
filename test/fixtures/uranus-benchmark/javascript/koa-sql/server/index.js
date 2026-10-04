const Koa = require('koa');
const Router = require('@koa/router');
const db = require('./db');
const app = new Koa();
const router = new Router();
router.get('/orders', async ctx => {
  ctx.body = await db.query('SELECT * FROM orders WHERE status = ' + ctx.query.status); // expect: SEC-001
});
app.use(router.routes());
