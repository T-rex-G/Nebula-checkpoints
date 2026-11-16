from flask import Flask, request
app = Flask(__name__)

class Reports:
    def run(self, sql):
        return cur.execute(sql)  # expect: SEC-001

    def by_region(self, region):
        return self.run("SELECT * FROM r WHERE region = '" + region + "'")

reports = Reports()

@app.route('/r')
def r():
    return reports.by_region(request.args.get('region'))
