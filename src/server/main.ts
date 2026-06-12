/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import "dotenv/config";
import express from "express";
import type { Server } from "node:http";
import apiRouter from "@/server/api";
import { Database } from "@/server/db";
import { seedDatabase } from "@/server/stories/seed";
import { logger } from "@/server/logger";

export interface ServerHandle {
  app: express.Express;
  shutdown: () => Promise<void>;
}

export async function startServer(): Promise<ServerHandle> {
  const app = express();
  const port = Number(process.env.CHORUS_PORT ?? 3000);

  app.use(express.json());
  app.use("/api", apiRouter);

  try {
    logger.info("[db] initializing...");
    await Database.getInstance();
    logger.info("[db] ready");

    await seedDatabase();

    const server: Server = await new Promise((resolve, reject) => {
      const s = app.listen(port, "0.0.0.0", () => {
        logger.info(`[start] server running on http://localhost:${port}`);
        resolve(s);
      });
      s.on("error", reject);
    });

    const shutdown = async () => {
      logger.info("Shutting down...");
      await Database.closeInstance();
      server.close();
    };

    return { app, shutdown };
  } catch (error) {
    logger.error("[start] fatal startup error:", error);
    process.exit(1);
  }
}

const _isMain = process.argv[1]?.endsWith("main.ts");
if (_isMain) {
  startServer().then(({ shutdown }) => {
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
  });
}
