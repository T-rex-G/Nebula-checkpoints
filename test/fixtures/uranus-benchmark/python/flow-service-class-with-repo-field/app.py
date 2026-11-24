from flask import Flask, request
from services.orders import OrderService
app = Flask(__name__)
orders = OrderService()

@app.route('/o')
def o():
    return orders.search(request.args.get('q'))
