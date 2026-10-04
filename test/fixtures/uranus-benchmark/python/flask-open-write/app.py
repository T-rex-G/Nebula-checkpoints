from flask import Flask, request
from flask_login import login_required, current_user
from .models import db, Note
app = Flask(__name__)

@app.post("/notes")
def create_note():  # expect: ACC-001
    db.session.add(Note(title=str(request.json['title'])))
    db.session.commit()
    return {'ok': True}

@app.get('/me')
@login_required
def me():
    return {'id': current_user.id}
