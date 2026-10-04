from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import requests

@app.route('/preview')
def preview():
    return requests.get(request.args['url'], timeout=5).text  # expect: SEC-021
