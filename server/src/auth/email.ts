/**
 * Sends the 6-digit sign-in code. With RESEND_API_KEY set it goes out through Resend's API
 * (free tier: 100 emails a day). Without it, on your own machine only, the code is printed in the
 * server log so you can sign in while developing. In production without a key, email sign-in is off.
 */
export async function sendSignInCode(email: string, code: string): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set");
    console.log(`[auth] (dev, no RESEND_API_KEY) sign-in code for ${email}: ${code}`);
    sentCodes.push({ email, code });
    return;
  }
  const from = process.env.EMAIL_FROM?.trim() || "Build or Not <onboarding@resend.dev>";
  const res = await fetch(process.env.RESEND_API_URL?.trim() || "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} is your Build or Not sign-in code`,
      text: `Your sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for 10 minutes. If you didn't ask for it, ignore this email.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

/** True when codes aren't really emailed: no RESEND_API_KEY, and not production. */
export const devEmail = () => !process.env.RESEND_API_KEY?.trim() && process.env.NODE_ENV !== "production";

/** Dev/test only: codes "sent" without an email service, newest last. */
export const sentCodes: { email: string; code: string }[] = [];
