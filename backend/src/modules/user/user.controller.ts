import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserService } from './user.service';

class UpdateCardDto {
  cardUid!: string;
}

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@Request() req: { user: { id: string } }) {
    const user = await this.userService.findById(req.user.id);
    return this.userService.sanitize(user);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('card')
  async updateCard(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdateCardDto,
  ) {
    const user = await this.userService.updateCardUid(req.user.id, dto.cardUid);
    return this.userService.sanitize(user);
  }

  @UseGuards(JwtAuthGuard)
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAll() {
    await this.userService.deleteAll();
  }
}
