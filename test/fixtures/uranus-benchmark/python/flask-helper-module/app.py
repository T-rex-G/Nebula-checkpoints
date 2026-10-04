from flask import Flask, request
from .queries import find_user
app = Flask(__name__)

@app.route('/lookup')
def lookup():
    return {'user': find_user(request.args['email'])}
