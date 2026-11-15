import html
import os
import shlex
from urllib.parse import quote_plus

from flask import Flask, request

from db import cur

app = Flask(__name__)


@app.route('/convert')
def convert():
    name = quote_plus(request.args.get('name'))
    os.system('convert uploads/' + name + ' out.png')  # expect: SEC-011
    return 'ok'
