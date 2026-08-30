import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { WebApiGuard } from "./web-api.guard.js";

@Module({controllers:[AppController],providers:[WebApiGuard]})
export class ApiModule {}
