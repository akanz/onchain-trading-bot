import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import type { Db, MongoClient } from "mongodb";
import { loadConfig } from "./config.js";
import { initializeMongo, type MongoState } from "./mongo.js";
import { TrackerService } from "./service.js";
import { BotStore } from "./store.js";
import type { Chain, TrackerConfig } from "./types.js";
import { priorityChains } from "./chain-priority.js";

const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

@Injectable()
export class RuntimeService implements OnModuleInit,OnModuleDestroy {
  private readonly logger=new Logger(RuntimeService.name);
  readonly config:TrackerConfig=loadConfig();
  mongo!:MongoState;
  tracker!:TrackerService;
  botStore!:BotStore;
  constructor(@InjectConnection() private readonly connection:Connection) {}

  get scheduledChains():Chain[]{
    const names=new Set((process.env.SCHEDULED_CHAINS??"robinhood,bsc,sol").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
    return priorityChains(this.config.enabled_chains.filter(chain=>names.has(chain)));
  }

  async onModuleInit():Promise<void>{
    if(!this.connection.db)throw new Error("Mongoose connected without a MongoDB database");
    const mongo=await initializeMongo(this.connection.getClient() as unknown as MongoClient,this.connection.db as unknown as Db);
    this.mongo=mongo;this.tracker=new TrackerService(this.config,undefined,undefined,undefined,undefined,mongo);this.botStore=new BotStore(mongo);
    await Promise.all([this.tracker.init(),this.botStore.init()]);
    if(!this.scheduledChains.length)throw new Error("SCHEDULED_CHAINS does not contain any enabled chain");
    this.logger.log(`MongoDB ready; scheduled chains: ${this.scheduledChains.join(", ")}`);
  }

  async onModuleDestroy():Promise<void>{
    await Promise.race([Promise.all([this.tracker?.close(),this.botStore?.close()]),sleep(1500)]);
  }
}
