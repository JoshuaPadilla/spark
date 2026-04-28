import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PaymentService } from './payment.service';

class TopupDto {
  amount!: number; // pesos
  successUrl!: string;
  cancelUrl!: string;
}

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  @UseGuards(JwtAuthGuard)
  @Post('topup')
  createTopup(@Req() req: { user: { id: string } }, @Body() dto: TopupDto) {
    return this.paymentService.createTopupLink(
      req.user.id,
      dto.amount,
      dto.successUrl,
      dto.cancelUrl,
    );
  }

  /** PayMongo webhook — no auth guard, verified by HMAC signature */
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() _body: unknown, // ensure body is parsed so rawBody is populated
  ) {
    const signature = req.headers['paymongo-signature'] as string;
    const rawBody = req.rawBody!.toString('utf8');

    this.logger.log(
      `Received PayMongo webhook delivery (signature: ${signature ? 'present' : 'missing'}, bytes: ${rawBody.length})`,
    );

    return this.paymentService.handleWebhook(rawBody, signature);
  }
}
