from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
SORTABLE = {'name', 'created_at'}

@app.route('/items')
def items():
    sort = request.args.get('sort', 'name')
    if sort not in SORTABLE:
        return {'error': 'bad sort'}, 400
    return {'rows': db.execute(f"SELECT * FROM items ORDER BY {sort}").fetchall()}
