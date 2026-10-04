from flask import Flask, request
from lxml import etree
app = Flask(__name__)
parser = etree.XMLParser(resolve_entities=True)

@app.post('/import')
def import_feed():
    return etree.tostring(etree.fromstring(request.data, parser))  # expect: SEC-034
