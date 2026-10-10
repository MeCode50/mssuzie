import { createServer, type Server } from "node:http";

export interface HealthReport {
  ok: boolean;
  [detail: string]: unknown;
}

/**
 * A tiny HTTP endpoint for the container health check (the worker has no other web surface). It reports only
 * whether the worker is alive and reaching the database, never run content. Bind it to the container's own
 * network; it is not meant to be published.
 */
export function startHealthServer(port: number, getHealth: () => HealthReport, host = "0.0.0.0"): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/")) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
      return;
    }
    const report = getHealth();
    res.writeHead(report.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: report.ok ? "ok" : "unhealthy", ...report }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
