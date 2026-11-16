from flask import Flask, request, jsonify, abort
from flask_login import login_required, current_user
from models import db, Invoice
app = Flask(__name__)
@app.route('/invoices/<int:invoice_id>')
@login_required
def invoice(invoice_id):  # expect: ACC-002 to-confirm
    inv = Invoice.query.get(invoice_id)
    return jsonify(inv.to_dict())
