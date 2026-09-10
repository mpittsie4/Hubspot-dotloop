import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { config } from "./config";
import { logger } from "./utils/logger";
import { authRouter } from "./routes/authRoutes";
import { healthRouter } from "./routes/healthRoutes";
import { hubspotWebhookRouter } from "./webhooks/hubspotWebhook";
import { hubspotProxyRouter } from "./routes/hubspotProxyRoutes";
import { dotloopWebhookRouter } from "./webhooks/dotloopWebhook";
import { scheduleReconciliation } from "./sync/reconcile";
import { migrate } from "./db/migrate";

const app = express();

app.use(cors());
app.use(pinoHttp({ logger }));

// Capture the raw request body alongside the parsed JSON so webhook
// signature verification (which HMACs the exact bytes HubSpot/Dotloop
// sent) works regardless of body-parser's re-serialization behavior.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString("utf8");
    },
  })
);

app.use("/auth", authRouter);
app.use("/health", healthRouter);
app.use("/webhooks/hubspot", hubspotWebhookRouter);
app.use("/api/hubspot", hubspotProxyRouter);
app.use("/webhooks/dotloop", dotloopWebhookRouter);

app.get("/", (_req, res) => {
  res.json({
    service: "hubspot-dotloop-connector",
    connect: {
      hubspot: "/auth/hubspot/start",
      dotloop: "/auth/dotloop/start",
    },
  });
});

async function main() {
  await migrate();
  logger.info("Database schema up to date");

  app.listen(config.port, () => {
    logger.info({ port: config.port }, "hubspot-dotloop-connector listening");
    scheduleReconciliation();
  });
}

main().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
