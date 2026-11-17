import { db } from '../db.js';
export const findById = id => db.query('SELECT * FROM u WHERE id = $1', [id]);
export const unsafe = id => db.query('SELECT * FROM u WHERE id = ' + id); // known-fp: SEC-001 to-confirm
