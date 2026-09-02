import {
  Controller,
  Get,
  Inject,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { parseChain } from "./config.js";
import { AlertStream } from "./alert-stream.js";
import { RuntimeService } from "./runtime.service.js";
import { WebApiGuard } from "./web-api.guard.js";

@Controller()
export class AppController {
  constructor(
    @Inject(RuntimeService) private readonly runtime: RuntimeService,
    @Inject(AlertStream) private readonly stream: AlertStream,
  ) {}

  @Get("health")
  health() {
    return { ok: true, chains: this.runtime.config.enabled_chains, database: "mongodb" };
  }

  @Get("api/chains")
  chains() {
    return {
      chains: this.runtime.config.enabled_chains,
      default: this.runtime.config.default_chain,
    };
  }

  @Get("api/roster/:chain")
  roster(@Param("chain") raw: string) {
    const chain = parseChain(raw, this.runtime.config);
    return { chain, wallets: this.runtime.tracker.roster(chain) };
  }

  @Get("api/alerts/:chain")
  alerts(@Param("chain") raw: string, @Query("limit") requested?: string) {
    const chain = parseChain(raw, this.runtime.config),
      limit = Math.min(Math.max(Number(requested) || 50, 1), 200);
    return { chain, alerts: this.runtime.tracker.alerts(chain, limit) };
  }

  @Get("api/discoveries/:chain")
  discoveries(
    @Param("chain") raw: string,
    @Query("limit") requested?: string,
    @Query("status") status?: string,
  ) {
    const chain = parseChain(raw, this.runtime.config),
      limit = Math.min(Math.max(Number(requested) || 50, 1), 200),
      allowed = status && ["passed", "suppressed", "pending"].includes(status) ? status : undefined;
    return { chain, discoveries: this.runtime.tracker.discoveryDecisions(chain, limit, allowed) };
  }

  @Sse("api/stream")
  events(): Observable<MessageEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: "ready",
        data: { ok: true, chains: this.runtime.config.enabled_chains },
      });
      const alert = (data: unknown) => subscriber.next({ type: "alert", data: data as object }),
        scan = (data: unknown) => subscriber.next({ type: "scan", data: data as object });
      const heartbeat = setInterval(
        () => subscriber.next({ type: "heartbeat", data: { timestamp: new Date().toISOString() } }),
        15000,
      );
      heartbeat.unref();
      this.stream.on("alert", alert);
      this.stream.on("scan", scan);
      return () => {
        clearInterval(heartbeat);
        this.stream.off("alert", alert);
        this.stream.off("scan", scan);
      };
    });
  }

  @Post("api/scan/:chain")
  @UseGuards(WebApiGuard)
  async scan(@Param("chain") raw: string) {
    return {
      alerts:
        raw === "all"
          ? await this.runtime.tracker.scanAll()
          : await this.runtime.tracker.scan(parseChain(raw, this.runtime.config)),
    };
  }

  @Post("api/token/:chain/:address/evaluate")
  @UseGuards(WebApiGuard)
  evaluate(@Param("chain") raw: string, @Param("address") address: string) {
    return this.runtime.tracker.evaluateToken(parseChain(raw, this.runtime.config), address);
  }
}
