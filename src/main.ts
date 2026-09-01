import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";

const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter());
let closing=false;
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{
  if(closing){process.exitCode=1;return;}
  closing=true;
  const deadline=setTimeout(()=>process.exit(0),4000);
  void app.close().finally(()=>{clearTimeout(deadline);process.exit(0);});
});
await app.listen({port:Number(process.env.PORT??3000),host:process.env.HOST??"127.0.0.1"});
