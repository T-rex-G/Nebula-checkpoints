from db import cur

def find_user(name):
    cur.execute('SELECT * FROM u WHERE n = %s', (name,))
    return cur.fetchall()
