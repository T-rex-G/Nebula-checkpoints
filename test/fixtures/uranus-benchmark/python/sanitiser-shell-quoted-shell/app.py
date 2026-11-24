import html
import os
import shlex
from urllib.parse import quote_plus

from flask import Flask, request

from db import cur

app = Flask(__name__)


@app.route('/convert')
def convert():
    name = shlex.quote(request.args.get('name'))
    os.system('convert ' + name + ' out.png')  # known-fp: SEC-011 to-confirm
    return 'ok'
