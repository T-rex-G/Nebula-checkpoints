from flask import Flask, request, jsonify, abort
from flask_login import login_required, current_user
from models import db, Invoice
app = Flask(__name__)
@app.route('/invoices/<int:invoice_id>', methods=['DELETE'])
@login_required
def delete_invoice(invoice_id):  # expect: ACC-002 to-confirm
    app.logger.info('delete by %s', current_user.id)
    inv = Invoice.query.get(invoice_id)
    db.session.delete(inv)
    db.session.commit()
    return '', 204
