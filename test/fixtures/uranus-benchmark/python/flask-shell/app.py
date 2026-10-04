from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import subprocess

@app.post('/ping')
def ping():
    host = request.json['host']
    return subprocess.run(f"ping -c 1 {host}", shell=True, capture_output=True).stdout  # expect: SEC-011
