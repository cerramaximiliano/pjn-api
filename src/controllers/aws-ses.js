const { logger } = require("../config/pino");
const { sendEmail } = require("../services/aws-ses");

// Controlador para enviar correos electrónicos
const sendEmailController = async (to, textBody, subject, attachments = []) => {
  if (!to || !textBody) {
    logWithDetails.warn("Faltan parámetros requeridos para enviar el correo.");
    return { error: "Se requiere 'to' y 'textBody'" };
  }

  const htmlBody = textBody
    .split("\n")
    .map((line) => `<p>${line}</p>`)
    .join("\n");

  try {
    const result = await sendEmail(to, subject, htmlBody, textBody, attachments);
    logger.info(`Correo enviado exitosamente a ${to}`);
    return { message: "Correo enviado exitosamente", result };
  } catch (error) {
    logger.error(`Error al enviar correo a ${to}:`, error);
    return { error: "Error al enviar el correo", details: error.message };
  }
};
module.exports = { sendEmailController };
