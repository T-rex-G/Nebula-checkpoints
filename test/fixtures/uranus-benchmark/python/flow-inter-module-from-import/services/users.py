from db import cur

def find_user(name):
    cur.execute("SELECT * FROM u WHERE n = '" + name + "'")  # expect: SEC-001
    return cur.fetchall()
