import { Controller, Get, Query } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('users')
export class UsersController {
  constructor(private readonly dataSource: DataSource) {}

  @Get('search')
  search(@Query('name') name: string) {
    return this.dataSource.query(`SELECT * FROM users WHERE name LIKE '%${name}%'`); // expect: SEC-001
  }
}
