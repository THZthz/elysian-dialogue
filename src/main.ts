import "dotenv/config";
import { startServer } from "@/server/main";
import { runRepl } from "@/console/main";
import { logger } from "@/server/logger";

async function main() {
  const { shutdown } = await startServer();

  const graceful = async () => {
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);
  process.on("uncaughtException", (error) => {
    logger.error("[process] uncaughtException — exiting:", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("[process] unhandledRejection:", reason);
  });

  await runRepl();
}

main().catch((err) => {
  logger.error("[main] fatal:", err);
  process.exit(1);
});
