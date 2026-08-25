import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { usersTable } from 'src/db/schema';

const db = drizzle(process.env.DATABASE_URL!);

@Injectable()
export class UsersService {
  constructor() { }

  private readonly logger = new Logger(UsersService.name);

  async insertUser(name: string, password: string) {
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const [user] = await db.insert(usersTable)
        .values({ username: name, password: hashedPassword })
        .returning();
      return user;
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  async findOne(name: string) {
    try {
      const users = await db.selectDistinct()
        .from(usersTable)
        .where(eq(usersTable.username, name))
        .limit(1)
      return users[0];
    } catch (error) {
      this.logger.error(error);
    }
  }

}
