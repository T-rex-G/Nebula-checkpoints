from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/users')
def users():
    name = request.args.get('name')
    return {'rows': db.execute(f"SELECT * FROM users WHERE name = '{name}'").fetchall()}  # expect: SEC-001
