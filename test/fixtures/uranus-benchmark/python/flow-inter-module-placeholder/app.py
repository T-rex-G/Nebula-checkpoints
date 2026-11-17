from flask import Flask, request
from services.users import find_user
app = Flask(__name__)

@app.route('/u')
def u():
    return find_user(request.args.get('name'))
