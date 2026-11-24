import html
import os
import shlex
from urllib.parse import quote_plus

from flask import Flask, request

from db import cur

app = Flask(__name__)


@app.route('/users')
def users():
    name = html.escape(request.args.get('name'))
    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")  # expect: SEC-001
    return {'rows': cur.fetchall()}
