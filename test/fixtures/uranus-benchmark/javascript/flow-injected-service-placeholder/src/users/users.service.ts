import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class UsersService {
  constructor(private readonly db: DataSource) {}

  findByName(name: string) {
    return this.db.query('SELECT * FROM users WHERE name = $1', [name]);
  }
}
