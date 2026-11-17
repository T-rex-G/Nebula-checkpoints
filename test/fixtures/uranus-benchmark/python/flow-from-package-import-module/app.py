from flask import Flask, request
from services import shell
app = Flask(__name__)

@app.route('/c')
def c():
    return shell.convert(request.args.get('file'))
