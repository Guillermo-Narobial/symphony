import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp-relay.gmail.com",
  port: 465,
  secure: true,
});

const FROM = "noreply@narobial.net";
const TO_PRIMARY = "guillermo.calleja@narobial.net";
const TO_FALLBACK = "guillermo.calleja@quiter.com";

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
