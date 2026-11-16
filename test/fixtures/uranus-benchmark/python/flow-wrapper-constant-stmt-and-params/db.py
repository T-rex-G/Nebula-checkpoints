import sqlite3
conn = sqlite3.connect('x.db')

def run(sql, params=()):
    cur = conn.cursor()
    cur.execute(sql, params)
    return cur.fetchall()
