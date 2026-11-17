import { OrderRepo } from './repo';

export class OrderService {
  private repo = new OrderRepo();
  constructor() { this.repo = new OrderRepo(); }
  async search(q: string) { return this.repo.like(q); }
}
