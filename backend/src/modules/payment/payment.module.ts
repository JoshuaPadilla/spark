import { Module } from '@nestjs/common';
import { UserModule } from '../user/user.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [UserModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
