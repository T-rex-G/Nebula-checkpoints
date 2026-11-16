import { db } from '../db.js';
export async function find(name) { return db.query(`SELECT * FROM u WHERE n = '${name}'`); } // expect: SEC-001
