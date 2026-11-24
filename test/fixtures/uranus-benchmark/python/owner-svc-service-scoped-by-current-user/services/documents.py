from models import Document

def load_for(user_id, doc_id):
    return Document.query.filter_by(id=doc_id, owner_id=user_id).first_or_404().to_dict()
