from flask import Flask, jsonify, abort
from flask_login import login_required, current_user
from services import documents
app = Flask(__name__)

@app.route('/documents/<int:doc_id>')
@login_required
def document(doc_id):  # expect: ACC-002 to-confirm
    return jsonify(documents.load_document(doc_id))
