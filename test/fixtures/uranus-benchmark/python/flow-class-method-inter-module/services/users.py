from db import cur

class UserService:
    def find(self, name):
        cur.execute("SELECT * FROM u WHERE n = '%s'" % name)  # expect: SEC-001
        return cur.fetchall()
