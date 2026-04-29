import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionsService } from './sessions.service';

class StartSessionDto {
  port!: number; // 1 or 2
  minutes!: number; // 1, 5, 10, or 20
}

class PortActionDto {
  port!: number;
}

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  /** Current MQTT port status (public — useful for device dashboards) */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@Req() req: { user: { id: string } }) {
    return this.sessionsService.getStatus(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('start')
  startSession(
    @Req() req: { user: { id: string } },
    @Body() dto: StartSessionDto,
  ) {
    return this.sessionsService.startSession(
      req.user.id,
      dto.port,
      dto.minutes,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('pause')
  pauseSession(
    @Req() req: { user: { id: string } },
    @Body() dto: PortActionDto,
  ) {
    return this.sessionsService.pauseSession(req.user.id, dto.port);
  }

  @UseGuards(JwtAuthGuard)
  @Post('resume')
  resumeSession(
    @Req() req: { user: { id: string } },
    @Body() dto: PortActionDto,
  ) {
    return this.sessionsService.resumeSession(req.user.id, dto.port);
  }
}
