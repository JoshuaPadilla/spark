import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [UserModule],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
