import sqlite3
conn = sqlite3.connect('x.db')

def run(sql):
    cur = conn.cursor()
    cur.execute(sql)  # expect: SEC-001
    return cur.fetchall()
