import { Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import { User } from './entities/user.entity';
import { UsersService } from 'src/users/users.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {

  constructor(
    private readonly userService: UsersService,
    private readonly jwtService: JwtService,
  ) { }

  private readonly logger = new Logger(AuthService.name);

  async validateUser(username: string, password: string): Promise<boolean | null> {
    const user = await this.userService.findOne(username);
    if (user && await bcrypt.compare(password, user.password)) {
      return true;
    }
    return null;
  }

  async login(user: User): Promise<{ access_token: string }> {
    let activeUser = await this.userService.findOne(user.username);

    if (!activeUser) {
      let result = await this.userService.insertUser(user.username, user.password);
      if (!result) {
        this.logger.error(`Failed to auto-register user: ${user.username}`);
        throw new InternalServerErrorException('Failed to create user account');
      }
      activeUser = result;
    }
    else {
      const isValidated = await this.validateUser(user.username, user.password);
      if (!isValidated) {
        this.logger.error(`Invalid credentials for user: ${user.username}`);
        throw new UnauthorizedException('Invalid credentials');
      }
    }

    const payload = { userId: activeUser.id, username: activeUser.username };
    return { access_token: this.jwtService.sign(payload) };
  }
}
