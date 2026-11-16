from flask import Flask, request, jsonify, abort
from flask_login import login_required, current_user
from models import db, Invoice
app = Flask(__name__)
@app.route('/invoices/<int:invoice_id>')
@login_required
def invoice(invoice_id):
    inv = Invoice.query.get(invoice_id)
    if inv is None or inv.owner_id != current_user.id:
        abort(404)
    return jsonify(inv.to_dict())
