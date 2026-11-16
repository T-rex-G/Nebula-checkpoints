import { db } from '../db.js';
export const findById = id => db.query('SELECT * FROM u WHERE id = ' + id); // expect: SEC-001
