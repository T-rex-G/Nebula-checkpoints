from models import Document

def load_document(doc_id):
    return Document.query.get_or_404(doc_id).to_dict()
