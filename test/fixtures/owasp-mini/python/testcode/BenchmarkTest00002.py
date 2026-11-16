from flask import request
import subprocess

def init(app):

	@app.route('/cmdi-00/BenchmarkTest00002', methods=['GET'])
	def BenchmarkTest00002():
		host = request.args.get('host', '')
		subprocess.run(['ping', '-c', '1', host])
		return 'done'
