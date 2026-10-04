from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')

@app.route('/continue')
def continue_to():
    return redirect(request.args.get('next'))  # expect: SEC-020
