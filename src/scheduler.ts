/**
 * GlobPod daily scheduler.
 *
 * Runs the pipeline every day at 09:45 local time by default (node-cron).
 * Override with PIPELINE_CRON in .env.
 * This is the entry point for production (`npm run start`).
 *
 * To run the pipeline immediately (without waiting for the scheduled time), use:
 *   npm run run-once
 */

import "dotenv/config";
import cron from "node-cron";
import { runPipeline } from "./index.js";

// Cron: minute hour day-of-month month day-of-week (local time of the host).
// Default 09:45 — override with PIPELINE_CRON in .env (e.g. "0 6 * * *" for 6:00).
const SCHEDULE = process.env.PIPELINE_CRON?.trim() || "45 9 * * *";

function scheduleLabel(): string {
  const parts = SCHEDULE.split(/\s+/);
  if (parts.length >= 2) {
    const minute = parts[0].padStart(2, "0");
    const hour = parts[1].padStart(2, "0");
    return `${hour}:${minute} local time`;
  }
  return SCHEDULE;
}

console.log(`GlobPod scheduler started — pipeline will run daily at ${scheduleLabel()}`);
console.log(`Cron expression: ${SCHEDULE}`);

cron.schedule(SCHEDULE, async () => {
  console.log(`\n[scheduler] Triggering pipeline at ${new Date().toISOString()}`);
  try {
    await runPipeline();
  } catch {
    // runPipeline already logs and sends the error email — just prevent crash
    console.error("[scheduler] Pipeline run failed — will retry at next scheduled time");
  }
});

/** Helper: human-readable tomorrow for the startup log. */
function getNextRunDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
