import html
import os
import shlex
from urllib.parse import quote_plus

from flask import Flask, request

from db import cur

app = Flask(__name__)


def sanitize_input(value):
    return value.strip()


@app.route('/users')
def users():
    name = sanitize_input(request.args.get('name'))
    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")  # expect: SEC-001 to-confirm
    return {'rows': cur.fetchall()}
