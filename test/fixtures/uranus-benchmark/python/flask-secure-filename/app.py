from flask import Flask, request, redirect
import sqlite3
app = Flask(__name__)
db = sqlite3.connect('app.db')
import os
from werkzeug.utils import secure_filename

@app.route('/docs')
def docs():
    page = secure_filename(request.args.get('page'))
    with open(os.path.join('/srv/docs', page)) as handle:
        return handle.read()
