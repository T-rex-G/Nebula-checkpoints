from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/users')
def users():
    return {'rows': db.execute("SELECT * FROM users WHERE name = ?", (request.args.get('name'),)).fetchall()}
