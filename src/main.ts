import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter());
app.enableShutdownHooks();
await app.listen({port:Number(process.env.PORT??3000),host:process.env.HOST??"127.0.0.1"});
