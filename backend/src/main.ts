import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: [/localhost:\d+$/, process.env.FRONTEND_URL].filter(Boolean),
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3010);
}
bootstrap();
