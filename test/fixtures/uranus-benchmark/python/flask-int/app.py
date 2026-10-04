from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/orders/<order_id>')
def order(order_id):
    key = int(order_id)
    return {'rows': db.execute(f"SELECT * FROM orders WHERE id = {key}").fetchall()}
