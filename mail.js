const nodemailer = require('nodemailer');

// Accept a single ordinary mailbox, not a display name, list, or header syntax.
function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
}
function mailConfigured() {
  const port = Number(process.env.SMTP_PORT || 587);
  return Boolean(process.env.SMTP_HOST && Number.isInteger(port) && port > 0 && port <= 65535 && process.env.SMTP_USER && process.env.SMTP_PASSWORD && isEmail(process.env.MAIL_FROM));
}
async function sendMail(to, subject, text) {
  if (!mailConfigured()) throw new Error('Email is not configured.');
  if (!isEmail(to)) throw new Error('Invalid recipient.');
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure, requireTLS: !secure, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, disableFileAccess: true, disableUrlAccess: true });
  try {
    const result = await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
    if (!Array.isArray(result.accepted) || result.accepted.length !== 1 || result.rejected?.length) throw new Error('Recipient not accepted by SMTP server.');
  } finally { transport.close(); }
}
async function notifyLogin(user, ownerEmail) {
  if (!mailConfigured()) return;
  const date = new Date().toUTCString();
  const tasks = [];
  if (isEmail(user.email)) tasks.push(sendMail(user.email, 'New sign-in to your Cryptly account', `A sign-in to your Cryptly account using ${user.provider} was completed on ${date}.\n\nIf this was not you, secure your sign-in provider account immediately.\n`));
  if (isEmail(ownerEmail)) tasks.push(sendMail(ownerEmail, 'Cryptly account sign-in', `A Cryptly account signed in using ${user.provider} on ${date}.\n\nThis is an owner notification.\n`));
  const results = await Promise.allSettled(tasks);
  if (results.some((result) => result.status === 'rejected')) console.error('One or more sign-in notification emails could not be sent.');
}
module.exports = { isEmail, mailConfigured, sendMail, notifyLogin };
