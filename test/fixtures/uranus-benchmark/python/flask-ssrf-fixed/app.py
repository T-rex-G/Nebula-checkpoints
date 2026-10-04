from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import requests

@app.route('/weather')
def weather():
    return requests.get('https://api.weather.example.com/v1/cities/' + request.args['city'], timeout=5).json()
