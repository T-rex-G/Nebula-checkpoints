from flask import Flask, request
import xml.dom.minidom
import xml.sax
import xml.sax.handler
app = Flask(__name__)

@app.route('/import', methods=['POST'])
def import_feed():
    parser = xml.sax.make_parser()
    parser.setFeature(xml.sax.handler.feature_external_ges, True)
    document = xml.dom.minidom.parseString(request.get_data(), parser)  # expect: SEC-034
    return {'items': len(document.getElementsByTagName('item'))}
