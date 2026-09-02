import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { join, resolve } from "node:path";
import { ApiModule } from "./api.module.js";
import { RuntimeModule } from "./runtime.module.js";
import { ScannerModule } from "./scanner.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(resolve(process.env.TRACKER_ROOT ?? process.cwd()), ".env"),
    }),
    RuntimeModule,
    ApiModule,
    ScannerModule,
  ],
})
export class AppModule {}
