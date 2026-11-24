from flask import Flask, request
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/items')
def items():
    name = request.args.get('name')
    if not name:
        name = 'all'
    return {'rows': db.execute("SELECT * FROM items WHERE name = '" + name + "'").fetchall()}  # expect: SEC-001 confirmed
