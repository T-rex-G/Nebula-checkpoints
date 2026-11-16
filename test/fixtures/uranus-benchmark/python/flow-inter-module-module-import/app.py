from flask import Flask, request
import services.users as users
app = Flask(__name__)

@app.route('/u')
def u():
    return users.find_user(request.args.get('name'))
