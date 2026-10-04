from flask import Flask, request
from flask_login import login_required, current_user
from .models import db, Note
app = Flask(__name__)

@app.post('/notes')
@login_required
def create_note():
    db.session.add(Note(title=str(request.json['title']), owner_id=current_user.id))
    db.session.commit()
    return {'ok': True}
