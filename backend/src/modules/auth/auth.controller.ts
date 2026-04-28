import {
  Body,
  Controller,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { UserService } from '../user/user.service';
import { AuthService, LoginDto, RegisterDto } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  /** Used by the frontend on page load / refresh to verify the token and
   * get the current user's profile without the password. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@Request() req: { user: { id: string } }) {
    const user = await this.userService.findById(req.user.id);
    return this.userService.sanitize(user);
  }
}
