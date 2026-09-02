import { Global, Module } from "@nestjs/common";
import { AlertStream } from "./alert-stream.js";
import { DatabaseModule } from "./database.module.js";
import { RuntimeService } from "./runtime.service.js";

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [RuntimeService, AlertStream],
  exports: [RuntimeService, AlertStream],
})
export class RuntimeModule {}
