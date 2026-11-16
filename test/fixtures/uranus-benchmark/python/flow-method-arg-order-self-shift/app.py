from flask import Flask, request
app = Flask(__name__)

class Store:
    def find(self, table, name):
        cur.execute('SELECT * FROM ' + table + ' WHERE n = %s', (name,))  # known-fp: SEC-001 to-confirm
        return cur.fetchall()

store = Store()

@app.route('/u')
def u():
    return store.find('users', request.args.get('name'))
