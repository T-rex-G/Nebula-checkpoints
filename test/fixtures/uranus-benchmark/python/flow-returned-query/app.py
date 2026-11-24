from flask import Flask, request
from sql import build
app = Flask(__name__)

@app.route('/u')
def u():
    q = build(request.args.get('name'))
    cur.execute(q)  # expect: SEC-001
    return 'ok'
