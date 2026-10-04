from flask import Flask, request, render_template
app = Flask(__name__)

@app.route('/card')
def card():
    return render_template('card.html', name=request.args.get('name'))
