from repo.orders import OrderRepo

class OrderService:
    def __init__(self):
        self.repo = OrderRepo()

    def search(self, q):
        return self.repo.like(q)
