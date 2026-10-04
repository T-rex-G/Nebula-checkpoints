import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get('name');
  const rows = await sql.query(`SELECT id, name FROM users WHERE name = '${name}'`); // expect: SEC-001
  return NextResponse.json(rows);
}
