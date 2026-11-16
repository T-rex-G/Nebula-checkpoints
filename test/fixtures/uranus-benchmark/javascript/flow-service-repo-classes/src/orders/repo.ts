import { pool } from '../db';

export class OrderRepo {
  async like(q: string) {
    return pool.query("SELECT * FROM orders WHERE note LIKE '%" + q + "%'"); // expect: SEC-001
  }
}
