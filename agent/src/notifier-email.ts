import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp-relay.gmail.com",
  port: 465,
  secure: true,
});

const FROM = "noreply@narobial.net";
const TO_PRIMARY = "guillermo.calleja@quiter.com";
const TO_FALLBACK = "guillermo.calleja@narobial.net";
const SMTP_RETRY_ATTEMPTS = 3;
const SMTP_RETRY_BASE_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientSmtpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const smtpError = error as Error & { responseCode?: number; code?: string };
  return smtpError.responseCode === 421
    || smtpError.responseCode === 450
    || smtpError.responseCode === 451
    || smtpError.responseCode === 452
    || smtpError.code === "ETIMEDOUT"
    || smtpError.code === "ECONNECTION"
    || smtpError.code === "ECONNRESET"
    || smtpError.code === "EAI_AGAIN";
}

async function sendMailWithRetry(mail: { from: string; subject: string; html: string }, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SMTP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await transporter.sendMail({ ...mail, to });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientSmtpError(error) || attempt === SMTP_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(SMTP_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

async function sendWithFallback(mail: { from: string; subject: string; html: string }, primary: string, fallback: string): Promise<void> {
  try {
    await sendMailWithRetry(mail, primary);
  } catch {
    await sendMailWithRetry(mail, fallback);
  }
}

export async function notifyRejectionEmail(taskId: string, reason: string): Promise<void> {
  const mail = {
    from: FROM,
    subject: `🚫 [Symphony] Q700 rechazada — ${taskId}`,
    html: `<h2>Issue rechazada: ${taskId}</h2><pre>${reason}</pre>`,
  };
  await sendWithFallback(mail, TO_PRIMARY, TO_FALLBACK);
}

export async function notifyEmail(subject: string, html: string): Promise<void> {
  const mail = { from: FROM, subject, html };
  await sendWithFallback(mail, TO_PRIMARY, TO_FALLBACK);
}

export async function notifyAgentFailureEmail(issueNumber: number, title: string, attempts: number, maxAttempts: number, reason: string): Promise<void> {
  const subject = `❌ [Symphony] Issue #${issueNumber} agotó reintentos (${attempts}/${maxAttempts})`;
  const html = `
    <h2>Issue no resuelta automáticamente</h2>
    <p><strong>Issue:</strong> #${issueNumber} — ${title}</p>
    <p><strong>Intentos agotados:</strong> ${attempts}/${maxAttempts}</p>
    <p><strong>Motivo final:</strong></p>
    <pre>${reason}</pre>
    <p>El agente ha dejado de relanzarla automáticamente hasta que se limpie su estado de reintentos.</p>
  `;

  await notifyEmail(subject, html);
}

export async function notifyAgentNoopEmail(issueNumber: number, title: string, attempts: number, maxAttempts: number, reason: string): Promise<void> {
  const subject = `⚠️ [Symphony] Issue #${issueNumber} terminó sin cambios (${attempts}/${maxAttempts})`;
  const html = `
    <h2>Ejecución sin cambios detectada</h2>
    <p><strong>Issue:</strong> #${issueNumber} — ${title}</p>
    <p><strong>Intento actual:</strong> ${attempts}/${maxAttempts}</p>
    <p><strong>Clasificación:</strong> el agente leyó la issue pero no materializó cambios, no encontró corrección clara, devolvió una salida vacía/no-op o el solver terminó sin tocar archivos.</p>
    <p><strong>Detalle técnico:</strong></p>
    <pre>${reason}</pre>
  `;

  await notifyEmail(subject, html);
}
