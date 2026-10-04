import sqlite3
db = sqlite3.connect('app.db')

def find_user(email):
    return db.execute("SELECT * FROM users WHERE email = '" + email + "'").fetchone()  # expect: SEC-001
