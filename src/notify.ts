/**
 * Notifications via Resend email.
 *
 * - Error alerts when a pipeline step fails
 * - Quota warnings when ElevenLabs usage crosses the threshold (LIV-11)
 */

import { Resend } from "resend";
import type { ElevenLabsQuota } from "./pipeline/generateAudio.js";

let resend: Resend | null = null;

function getResend(): Resend {
  if (resend) return resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: RESEND_API_KEY");
  resend = new Resend(apiKey);
  return resend;
}

/**
 * Send an error alert email when a pipeline step fails.
 *
 * @param step  - The name of the failing pipeline step (e.g. "generateScript")
 * @param error - The caught Error object
 */
export async function sendErrorEmail(step: string, error: Error): Promise<void> {
  const toEmail = process.env.NOTIFY_EMAIL;
  if (!toEmail) {
    console.error("[notify] NOTIFY_EMAIL not set — skipping error email");
    return;
  }

  const date = new Date().toISOString();
  const subject = `[GlobPod] Pipeline failure: ${step}`;

  const html = `
    <h2>GlobPod pipeline error</h2>
    <p><strong>Step:</strong> ${step}</p>
    <p><strong>Time:</strong> ${date}</p>
    <p><strong>Error:</strong> ${error.message}</p>
    <pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-size:12px;">${
      error.stack ?? "(no stack trace)"
    }</pre>
  `.trim();

  try {
    await getResend().emails.send({
      from: "GlobPod <onboarding@resend.dev>", // Resend default sender for free tier
      to: toEmail,
      subject,
      html,
    });
    console.log(`[notify] Error email sent to ${toEmail}`);
  } catch (sendErr) {
    // Don't let the notification failure mask the original error
    console.error("[notify] Failed to send error email:", sendErr);
  }
}

/**
 * Warn when ElevenLabs character usage is at/above the configured threshold.
 * Best-effort — never throws into the pipeline.
 */
export async function sendQuotaWarningEmail(quota: ElevenLabsQuota): Promise<void> {
  const toEmail = process.env.NOTIFY_EMAIL;
  if (!toEmail) {
    console.error("[notify] NOTIFY_EMAIL not set — skipping quota warning email");
    return;
  }

  const pct = Math.round(quota.ratio * 100);
  const subject = `[GlobPod] ElevenLabs quota warning: ${pct}% used`;
  const html = `
    <h2>ElevenLabs usage is high</h2>
    <p><strong>Used:</strong> ${quota.characterCount.toLocaleString()} / ${quota.characterLimit.toLocaleString()} characters (${pct}%)</p>
    <p>GlobPod will keep running, but TTS may fail once the monthly character limit is hit. Consider upgrading the plan or pausing daily runs.</p>
    <p><strong>Time:</strong> ${new Date().toISOString()}</p>
  `.trim();

  try {
    await getResend().emails.send({
      from: "GlobPod <onboarding@resend.dev>",
      to: toEmail,
      subject,
      html,
    });
    console.log(`[notify] Quota warning email sent to ${toEmail} (${pct}%)`);
  } catch (sendErr) {
    console.error("[notify] Failed to send quota warning email:", sendErr);
  }
}
