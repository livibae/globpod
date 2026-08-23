/**
 * Error notification via Resend email.
 *
 * Called by the pipeline orchestrator when any step fails.
 * Sends a formatted error email with the step name, error message, and stack trace.
 */

import { Resend } from "resend";

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
