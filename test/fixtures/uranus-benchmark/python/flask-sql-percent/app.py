from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/orders')
def orders():
    status = request.args['status']
    cursor = db.cursor()
    cursor.execute("SELECT * FROM orders WHERE status = '%s'" % status)  # expect: SEC-001
    return {'rows': cursor.fetchall()}
