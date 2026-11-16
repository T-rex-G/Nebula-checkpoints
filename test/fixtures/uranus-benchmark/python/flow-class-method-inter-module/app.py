from flask import Flask, request
from services.users import UserService
app = Flask(__name__)
svc = UserService()

@app.route('/u')
def u():
    return svc.find(request.args.get('name'))
