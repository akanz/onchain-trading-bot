import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";

@Module({
  imports:[MongooseModule.forRootAsync({
    inject:[ConfigService],
    useFactory:(config:ConfigService)=>{
      const uri=config.get<string>("MONGODB_URI")??config.get<string>("MONGO_URL");
      if(!uri)throw new Error("MONGODB_URI or MONGO_URL is required");
      return {uri,dbName:config.get<string>("MONGODB_DATABASE")??"onchain_trading_bot",maxPoolSize:Number(config.get<string>("MONGODB_MAX_POOL_SIZE")??10)};
    },
  })],
  exports:[MongooseModule],
})
export class DatabaseModule {}
