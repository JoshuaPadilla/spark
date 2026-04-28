import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { User } from '../user/entity/user.entity';
import { PaymentWebhookEvent } from './entity/payment-webhook-event.entity';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly apiBase = 'https://api.paymongo.com/v1';

  constructor(
    private readonly configService: ConfigService, // 2. Inject ConfigService
    private readonly dataSource: DataSource,
  ) {
    // 3. Assign values inside the constructor
    this.secretKey =
      this.configService.get<string>('PAYMONGO_SECRET_KEY') ??
      'sk_test_fallback';
    this.webhookSecret =
      this.configService.get<string>('PAYMONGO_WEBHOOK_SECRET') ??
      'whsk_fallback';

    // Optional: Log to verify it's working (don't log the full key for security!)
    this.logger.log(
      `Payment Service initialized. Key starts with: ${this.secretKey.substring(0, 7)}`,
    );
  }

  async createTopupLink(
    userId: string,
    amountPesos: number,
    successUrl: string,
    cancelUrl: string,
  ) {
    if (amountPesos < 20) {
      throw new BadRequestException('Minimum top-up amount is ₱20');
    }

    const amountCentavos = Math.round(amountPesos * 100);

    const authHeader = `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`;

    const { data } = await axios.post(
      `${this.apiBase}/checkout_sessions`,
      {
        data: {
          attributes: {
            billing: {
              name: `Spark User ${userId.slice(0, 8)}`,
            },
            send_email_receipt: false,
            show_description: true,
            show_line_items: true,
            cancel_url: cancelUrl,
            success_url: successUrl,
            payment_method_types: ['gcash'],
            line_items: [
              {
                currency: 'PHP',
                amount: amountCentavos,
                name: 'Spark Wallet Top-up',
                quantity: 1,
                description: 'GCash wallet top-up for Spark',
              },
            ],
            metadata: {
              userId,
              kind: 'topup',
            },
          },
        },
      },
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      },
    );

    const link = data?.data;
    return {
      checkoutUrl: link?.attributes?.checkout_url as string,
      referenceNumber: (link?.id as string) ?? '',
    };
  }

  async handleWebhook(rawBody: string, signature: string) {
    if (!signature) {
      this.logger.warn(
        'PayMongo webhook rejected: missing paymongo-signature header',
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    if (!this.verifySignature(rawBody, signature)) {
      this.logger.warn(
        'PayMongo webhook rejected: signature verification failed. Check PAYMONGO_WEBHOOK_SECRET and the raw request body handling.',
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody) as Record<string, unknown>;
    const eventId =
      typeof (event?.data as Record<string, unknown> | undefined)?.id ===
      'string'
        ? ((event.data as Record<string, unknown>).id as string)
        : 'unknown';
    const eventType = (event?.data as Record<string, unknown>)?.attributes
      ? (
          (event.data as Record<string, unknown>).attributes as Record<
            string,
            unknown
          >
        )?.type
      : null;

    this.logger.log(
      `PayMongo webhook received: ${String(eventType)} (event: ${eventId})`,
    );

    if (eventType === 'link.payment.paid') {
      const linkAttrs = (
        (
          (event?.data as Record<string, unknown>)?.attributes as Record<
            string,
            unknown
          >
        )?.data as Record<string, unknown>
      )?.attributes as Record<string, unknown> | undefined;

      const remarks = (linkAttrs?.remarks as string) ?? '';
      const amountCentavos = (linkAttrs?.amount as number) ?? 0;

      // remarks format is "topup:<userId>"
      const match = remarks.match(/^topup:(.+)$/);
      if (match) {
        const userId = match[1];
        const amountPesos = amountCentavos / 100;
        const wasCredited = await this.creditTopupOnce(
          eventId,
          'link.payment.paid',
          userId,
          amountPesos,
        );

        if (wasCredited) {
          this.logger.log(`Credited ₱${amountPesos} to user ${userId}`);
        }
      } else {
        this.logger.warn(
          `Could not extract user ID from remarks: "${remarks}"`,
        );
      }
    }

    if (eventType === 'checkout_session.payment.paid') {
      const checkoutAttrs = (
        (
          (event?.data as Record<string, unknown>)?.attributes as Record<
            string,
            unknown
          >
        )?.data as Record<string, unknown>
      )?.attributes as Record<string, unknown> | undefined;

      const metadata =
        (checkoutAttrs?.metadata as Record<string, unknown> | undefined) ??
        ((
          (checkoutAttrs?.payment_intent as Record<string, unknown> | undefined)
            ?.attributes as Record<string, unknown> | undefined
        )?.metadata as Record<string, unknown> | undefined);

      const userId =
        typeof metadata?.userId === 'string' ? metadata.userId : undefined;

      const amountCentavos =
        this.readAmount(
          (
            (
              checkoutAttrs?.payment_intent as
                | Record<string, unknown>
                | undefined
            )?.attributes as Record<string, unknown> | undefined
          )?.amount,
        ) ??
        this.sumLineItems(checkoutAttrs?.line_items) ??
        this.readAmount(checkoutAttrs?.amount);

      if (userId && amountCentavos) {
        const amountPesos = amountCentavos / 100;
        const wasCredited = await this.creditTopupOnce(
          eventId,
          'checkout_session.payment.paid',
          userId,
          amountPesos,
        );

        if (wasCredited) {
          this.logger.log(`Credited ₱${amountPesos} to user ${userId}`);
        }
      } else {
        this.logger.warn(
          `Could not extract checkout top-up details from webhook: ${JSON.stringify(checkoutAttrs ?? {})}`,
        );
      }
    }

    if (eventType === 'payment.paid') {
      this.logger.log(
        'PayMongo webhook ignored: payment.paid is a secondary payment event for checkout sessions and would double-credit the wallet.',
      );
    }

    if (
      eventType !== 'link.payment.paid' &&
      eventType !== 'checkout_session.payment.paid' &&
      eventType !== 'payment.paid'
    ) {
      this.logger.log(
        `PayMongo webhook ignored: unsupported event type ${String(eventType)}`,
      );
    }

    return { received: true };
  }

  private async creditTopupOnce(
    eventId: string,
    eventType: string,
    userId: string,
    amountPesos: number,
  ): Promise<boolean> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(PaymentWebhookEvent).insert({
          eventId,
          eventType,
          userId,
          amount: amountPesos,
        });

        const userRepo = manager.getRepository(User);
        const user = await userRepo.findOne({ where: { id: userId } });

        if (!user) {
          throw new NotFoundException(`User ${userId} not found`);
        }

        user.balance = user.balance + amountPesos;
        await userRepo.save(user);
      });

      return true;
    } catch (error) {
      if (this.isDuplicatePaymentEvent(error)) {
        this.logger.warn(
          `Skipping duplicate PayMongo webhook event ${eventId} (${eventType})`,
        );
        return false;
      }

      throw error;
    }
  }

  private readAmount(value: unknown): number | undefined {
    return typeof value === 'number' && value > 0 ? value : undefined;
  }

  private sumLineItems(value: unknown): number | undefined {
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }

    let total = 0;

    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        return undefined;
      }

      const amount = (item as Record<string, unknown>).amount;
      const quantity = (item as Record<string, unknown>).quantity;

      if (typeof amount !== 'number' || typeof quantity !== 'number') {
        return undefined;
      }

      total += amount * quantity;
    }

    return total > 0 ? total : undefined;
  }

  private verifySignature(rawBody: string, signature: string): boolean {
    try {
      const parts = signature.split(',');
      const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
      const signedHex =
        parts.find((p) => p.startsWith('te='))?.slice(3) ??
        parts.find((p) => p.startsWith('li='))?.slice(3) ??
        parts.find((p) => p.startsWith('v1='))?.slice(3);

      if (!timestamp || !signedHex) return false;

      const message = `${timestamp}.${rawBody}`;
      const computedHmac = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(message)
        .digest('hex');

      const expected = Buffer.from(computedHmac, 'hex');
      const actual = Buffer.from(signedHex, 'hex');

      if (expected.length === 0 || expected.length !== actual.length) {
        return false;
      }

      // Constant-time comparison to prevent timing attacks
      return crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  private isDuplicatePaymentEvent(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      typeof error.driverError === 'object' &&
      error.driverError !== null &&
      'code' in error.driverError &&
      error.driverError.code === '23505'
    );
  }
}
