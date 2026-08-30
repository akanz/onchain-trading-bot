import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";
import type { Alert } from "./types.js";

export interface ScanEvent {
  scannedAt: string;
  found: number;
}

@Injectable()
export class AlertStream extends EventEmitter {
  publishAlert(alert: Alert): void {
    this.emit("alert", alert);
  }

  publishScan(event: ScanEvent): void {
    this.emit("scan", event);
  }
}

export function isDeliverableAlert(alert: Alert): boolean {
  if(alert.kind==="MULTIPLE")return true;
  const tiers = new Set(
    (process.env.ALERT_TIERS ?? "CALL,RESEARCH")
      .split(",")
      .map(value => value.trim().toUpperCase())
      .filter(Boolean),
  );
  return tiers.has(alert.tier);
}
