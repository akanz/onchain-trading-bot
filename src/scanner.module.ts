import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ScannerService } from "./scanner.service.js";
import { TelegramModule } from "./telegram.module.js";

@Module({ imports: [ScheduleModule.forRoot(), TelegramModule], providers: [ScannerService] })
export class ScannerModule {}
