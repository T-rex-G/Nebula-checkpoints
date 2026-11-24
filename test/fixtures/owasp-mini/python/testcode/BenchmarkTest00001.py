from flask import request
import subprocess

def init(app):

	@app.route('/cmdi-00/BenchmarkTest00001', methods=['GET'])
	def BenchmarkTest00001():
		host = request.args.get('host', '')
		subprocess.run('ping -c 1 ' + host, shell=True)
		return 'done'
