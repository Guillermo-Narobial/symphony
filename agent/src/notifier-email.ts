import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp-relay.gmail.com",
  port: 465,
  secure: true,
});

const FROM = "noreply@narobial.net";
const TO_PRIMARY = "guillermo.calleja@quiter.com";
const TO_FALLBACK = "guillermo.calleja@narobial.net";

export async function notifyRejectionEmail(taskId: string, reason: string): Promise<void> {
  const mail = {
    from: FROM,
    subject: `🚫 [Symphony] Q700 rechazada — ${taskId}`,
    html: `<h2>Issue rechazada: ${taskId}</h2><pre>${reason}</pre>`,
  };
  try {
    await transporter.sendMail({ ...mail, to: TO_PRIMARY });
  } catch {
    await transporter.sendMail({ ...mail, to: TO_FALLBACK });
  }
}

export async function notifyEmail(subject: string, html: string): Promise<void> {
  const mail = { from: FROM, subject, html };
  try {
    await transporter.sendMail({ ...mail, to: `${TO_PRIMARY}, ${TO_FALLBACK}` });
  } catch {
    try { await transporter.sendMail({ ...mail, to: TO_FALLBACK }); } catch {}
  }
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
