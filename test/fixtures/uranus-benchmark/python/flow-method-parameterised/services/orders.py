from db import cur

class OrderService:
    def search(self, q):
        cur.execute('SELECT * FROM orders WHERE note LIKE %s', ('%' + q + '%',))
        return cur.fetchall()
