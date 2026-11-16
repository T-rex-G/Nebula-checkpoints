from flask import Flask, request
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/items')
def items():
    query = {'label': 'Search'}
    query['term'] = request.args.get('term')
    return {'rows': db.execute("SELECT * FROM items WHERE name = '" + query['term'] + "'").fetchall()}  # expect: SEC-001 confirmed
