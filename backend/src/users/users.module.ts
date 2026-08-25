import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

@Module({
  exports: [UsersService],
  controllers: [],
  providers: [UsersService],
})
export class UsersModule {}
