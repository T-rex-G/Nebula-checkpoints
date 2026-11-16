from flask import Flask, request
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/items')
def items():
    order = request.args.get('order')
    if order == 'desc':
        order = 'DESC'
    elif order == 'name':
        order = 'NAME'
    else:
        order = 'ASC'
    return {'rows': db.execute('SELECT * FROM items ORDER BY name ' + order).fetchall()}  # known-fp: SEC-001
