import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { JwtPayload } from './jwt.strategy';

export interface LoginDto {
  username: string;
  password: string;
}

export interface RegisterDto {
  username: string;
  password: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
  ) {}

  async validateUser(username: string, password: string) {
    const normalizedUsername = this.normalizeUsername(username);
    const user = await this.userService.findByUsername(normalizedUsername);
    if (!user) return null;
    const match = await bcrypt.compare(password, user.password);
    return match ? user : null;
  }

  async login(dto: LoginDto): Promise<{ access_token: string }> {
    const username = this.normalizeUsername(dto.username);
    const password = this.normalizePassword(dto.password);
    const user = await this.validateUser(username, password);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const payload: JwtPayload = { sub: user.id, username: user.username };
    return { access_token: this.jwtService.sign(payload) };
  }

  async register(dto: RegisterDto) {
    const username = this.normalizeUsername(dto.username);
    const password = this.normalizePassword(dto.password);
    const user = await this.userService.create(username, password);
    return this.userService.sanitize(user);
  }

  private normalizeUsername(username: string) {
    if (typeof username !== 'string') {
      throw new BadRequestException('Username is required');
    }

    const normalized = username.trim();
    if (!normalized) {
      throw new BadRequestException('Username is required');
    }

    return normalized;
  }

  private normalizePassword(password: string) {
    if (typeof password !== 'string') {
      throw new BadRequestException('Password is required');
    }

    if (!password.trim()) {
      throw new BadRequestException('Password is required');
    }

    return password;
  }
}
