import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './redis-io-adapter/redis-io-adapter';
import cookieParser from 'cookie-parser';
require('dotenv').config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new Logger());
  app.enableCors({
    origin: process.env.SOCKET_ORIGIN,
    credentials: true,
  });

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe());


  await app.listen(process.env.PORT!);
}
bootstrap();
