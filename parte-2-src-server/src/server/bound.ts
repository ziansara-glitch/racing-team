import "server-only";
import { writeAudit, type AuditInput } from "@/server/audit";
import { db } from "@/server/db";
import { hit, peek, reset, type Limit } from "@/server/rate-limit";

// Le funzioni "pure" (audit, rate-limit) prendono la connessione per essere testabili; qui sono
// agganciate al database dell'app.

export const audit = (input: AuditInput) => writeAudit(db, input);

export const limiter = {
  hit: (bucket: string, key: string, cfg: Limit) => hit(db, bucket, key, cfg),
  peek: (bucket: string, key: string, cfg: Limit) => peek(db, bucket, key, cfg),
  reset: (bucket: string, key: string) => reset(db, bucket, key),
};
