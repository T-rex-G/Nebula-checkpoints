import html
import os
import shlex
from urllib.parse import quote_plus

from flask import Flask, request

from db import cur

app = Flask(__name__)


@app.route('/hello')
def hello():
    name = html.escape(request.args.get('name'))
    return '<h1>Hello ' + name + '</h1>'
