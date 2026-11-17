from db import cur

class OrderRepo:
    def like(self, q):
        cur.execute("SELECT * FROM orders WHERE note LIKE '%" + q + "%'")  # expect: SEC-001
        return cur.fetchall()
