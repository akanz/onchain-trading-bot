import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import type { Bot } from "grammy";
import { broadcast, broadcastDegen, broadcastPotential, broadcastSurged, broadcastTrending, createTelegramBot } from "./telegram.js";
import { RuntimeService } from "./runtime.service.js";
import type { Alert, Chain, Json } from "./types.js";

export interface DeliveryResult {attempted:number;sent:number;failed:number;}
const emptyDelivery=():DeliveryResult=>({attempted:0,sent:0,failed:0});
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

@Injectable()
export class TelegramService implements OnApplicationBootstrap,OnApplicationShutdown {
  private readonly logger=new Logger(TelegramService.name);
  private bot?:Bot;
  private startTask?:Promise<void>;
  private stopping=false;
  constructor(@Inject(RuntimeService) private readonly runtime:RuntimeService) {}

  get enabled():boolean{return Boolean(this.bot);}

  onApplicationBootstrap():void {
    const token=process.env.TELEGRAM_BOT_TOKEN;
    if(!token){this.logger.warn("TELEGRAM_BOT_TOKEN is unset; SSE remains active but Telegram polling is disabled.");return;}
    this.bot=createTelegramBot(token,this.runtime.tracker,this.runtime.config,this.runtime.botStore);
    if(process.env.TELEGRAM_POLLING_ENABLED==="false"){this.logger.log("Telegram command polling is disabled in this process; outgoing alert delivery remains enabled.");return;}
    this.startTask=this.bot.start({onStart:info=>this.logger.log(`Telegram bot @${info.username} started`)}).catch(error=>{if(!this.stopping)this.logger.error("Telegram polling stopped unexpectedly",error instanceof Error?error.stack:String(error));});
  }

  alert(alert:Alert):Promise<DeliveryResult>{return this.bot&&!this.stopping?broadcast(this.bot,this.runtime.botStore,alert):Promise.resolve(emptyDelivery());}
  trending(chains:Chain[],rows:Json[]):Promise<DeliveryResult>{return this.bot&&!this.stopping?broadcastTrending(this.bot,this.runtime.botStore,chains,rows):Promise.resolve(emptyDelivery());}
  degen(chains:Chain[],rows:Json[]):Promise<DeliveryResult>{return this.bot&&!this.stopping?broadcastDegen(this.bot,this.runtime.botStore,chains,rows):Promise.resolve(emptyDelivery());}
  surged(chains:Chain[],rows:Json[]):Promise<DeliveryResult>{return this.bot&&!this.stopping?broadcastSurged(this.bot,this.runtime.botStore,chains,rows):Promise.resolve(emptyDelivery());}
  potential(chains:Chain[],rows:Json[]):Promise<DeliveryResult>{return this.bot&&!this.stopping?broadcastPotential(this.bot,this.runtime.botStore,chains,rows):Promise.resolve(emptyDelivery());}

  async onApplicationShutdown():Promise<void>{this.stopping=true;if(this.bot?.isRunning())await this.bot.stop().catch(()=>{});await Promise.race([this.startTask??Promise.resolve(),sleep(1000)]);}
}
