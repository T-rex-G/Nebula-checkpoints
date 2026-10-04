import base64
import pickle
from flask import Flask, request
app = Flask(__name__)

@app.post('/restore')
def restore():
    return pickle.loads(base64.b64decode(request.data))  # expect: SEC-024
