from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import subprocess

@app.post('/ping')
def ping():
    return subprocess.run(['ping', '-c', '1', request.json['host']], capture_output=True).stdout
