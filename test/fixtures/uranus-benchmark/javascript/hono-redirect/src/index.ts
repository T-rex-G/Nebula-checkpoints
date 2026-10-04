import { Hono } from 'hono';
const app = new Hono();
app.get('/out', c => {
  return c.redirect(c.req.query('to') || '/'); // expect: SEC-020
});
export default app;
