from flask import Flask, request, render_template_string
app = Flask(__name__)

@app.route('/card')
def card():
    return render_template_string(request.args.get('template', 'Hello'))  # expect: SEC-030
