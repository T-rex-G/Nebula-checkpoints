from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import os

@app.route('/docs')
def docs():
    page = request.args.get('page')
    with open(os.path.join('/srv/docs', page)) as handle:  # expect: SEC-022
        return handle.read()
