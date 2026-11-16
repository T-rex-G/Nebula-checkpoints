from flask import Flask, request
app = Flask(__name__)

@app.route('/hello')
def hello():
    name = request.args.get('name', '')
    return 'Hello ' + name  # expect: SEC-033 to-confirm
