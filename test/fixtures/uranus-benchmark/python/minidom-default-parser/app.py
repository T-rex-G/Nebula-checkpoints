from flask import Flask, request
import xml.dom.minidom
app = Flask(__name__)

@app.route('/import', methods=['POST'])
def import_feed():
    document = xml.dom.minidom.parseString(request.get_data())
    return {'items': len(document.getElementsByTagName('item'))}
