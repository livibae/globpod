/**
 * GlobPod daily scheduler.
 *
 * Runs the pipeline every day at 6:00 AM local time using node-cron.
 * This is the entry point for production (`npm run start`).
 *
 * To run the pipeline immediately (without waiting for 6 AM), use:
 *   npm run run-once
 */

import "dotenv/config";
import cron from "node-cron";
import { runPipeline } from "./index.js";

// Cron expression: every day at 06:00 local time
// Format: second(optional) minute hour day-of-month month day-of-week
const SCHEDULE = "0 6 * * *";

console.log("GlobPod scheduler started — pipeline will run daily at 06:00 local time");
console.log(`Next run scheduled at 06:00 on ${getNextRunDate()}`);

cron.schedule(SCHEDULE, async () => {
  console.log(`\n[scheduler] Triggering pipeline at ${new Date().toISOString()}`);
  try {
    await runPipeline();
  } catch {
    // runPipeline already logs and sends the error email — just prevent crash
    console.error("[scheduler] Pipeline run failed — will retry at next scheduled time");
  }
});

/** Helper: returns a human-readable string of tomorrow's date for the startup log. */
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
