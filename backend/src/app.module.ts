import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { PaymentWebhookEvent } from './modules/payment/entity/payment-webhook-event.entity';
import { PaymentModule } from './modules/payment/payment.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { User } from './modules/user/entity/user.entity';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Makes ConfigService available everywhere
      envFilePath: '.env', // Defaults to .env in root, but you can be explicit
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USER ?? 'oyao',
      password: process.env.DB_PASS ?? 'oyao123',
      database: process.env.DB_NAME ?? 'oyao_db',
      entities: [User, PaymentWebhookEvent],
      synchronize: true,
    }),
    AuthModule,
    UserModule,
    MqttModule,
    PaymentModule,
    SessionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
