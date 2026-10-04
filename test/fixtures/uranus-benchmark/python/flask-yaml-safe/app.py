import yaml
from flask import Flask, request
app = Flask(__name__)

@app.post('/config')
def config():
    return yaml.safe_load(request.data)
