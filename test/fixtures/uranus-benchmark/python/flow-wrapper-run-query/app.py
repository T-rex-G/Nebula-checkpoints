from flask import Flask, request
import db
app = Flask(__name__)

@app.route('/u')
def u():
    return db.run("SELECT * FROM u WHERE n = '%s'" % request.args.get('name'))
