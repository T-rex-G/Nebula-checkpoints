from flask import Flask, request, jsonify, abort
from flask_login import login_required, current_user
from models import db, Invoice
app = Flask(__name__)
@app.route('/invoices/<int:invoice_id>')
@login_required
def invoice(invoice_id):
    inv = Invoice.query.filter_by(id=invoice_id, user_id=current_user.id).first_or_404()
    return jsonify(inv.to_dict())
