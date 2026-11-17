from flask import Flask, request
app = Flask(__name__)

def run(sql):
    return cur.execute(sql)  # expect: SEC-001

def find(name):
    return run("SELECT * FROM u WHERE n = '" + name + "'")

@app.route('/u')
def u():
    return find(request.args.get('name'))
