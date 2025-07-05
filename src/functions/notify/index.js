import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const REGION = process.env.AWS_REGION || "sa-east-1";
const snsClient = new SNSClient({ region: REGION });

// Inline notifyUser function (from shared layer)
const NOTIFICATION_TEMPLATES = {
  success: {
    topicArn:
      process.env.TOPIC_SNS_NOTIFICATION ||
      "arn:aws:sns:sa-east-1:905418161107:Notifications-in-lambdas-RadioIA",
    subject: (fileName) =>
      `Tu archivo ${fileName.substring(0, 50)} ha sido completamente procesado`,
    message: (fileName, videoUrl) => `
      Hola,
      Tu archivo ${fileName} ha sido procesado exitosamente.
      Ya puedes revisar el video en: ${videoUrl}
    `,
  },
  error: {
    topicArn:
      process.env.TOPIC_SNS_ERROR ||
      "arn:aws:sns:sa-east-1:905418161107:Errors-in-lambdas-RadioIA",
    subject: (fileName) => `Error processing: ${fileName.substring(0, 50)}...`,
    message: (fileName, errorMessage) => `
      Hola,
      Hubo un error al procesar tu archivo ${fileName}.
            <br>
      <br>
      Error: ${errorMessage || "Error desconocido"}
      <br>
      <br>
      Tu administrador ya fue contactado y está revisando el problema.
    `,
  },
};

async function notifyUser(
  fileKey,
  isError = false,
  errorMessage = null,
  videoUrl = null
) {
  try {
    const fileName = fileKey.split("/").pop().split(".")[0];
    const template = isError
      ? NOTIFICATION_TEMPLATES.error
      : NOTIFICATION_TEMPLATES.success;

    const params = {
      TopicArn: template.topicArn,
      Subject: template.subject(fileName),
      Message: isError
        ? template.message(fileName, errorMessage)
        : template.message(fileName, videoUrl),
    };

    await snsClient.send(new PublishCommand(params));
    console.log(`SNS notification sent successfully for file: ${fileName}`);
    return true;
  } catch (error) {
    console.error("Error sending SNS notification:", error);
    throw error;
  }
}

export const handler = async (event) => {
  console.log(
    "Notify function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    const { fileKey, isError = false, error, videoUrl } = event;

    if (!fileKey) {
      throw new Error("Missing required parameter: fileKey");
    }

    // Extract a meaningful error message if there is an error
    let errorMessage = null;
    if (isError && error) {
      if (typeof error === "string") {
        errorMessage = error;
      } else if (error.message) {
        errorMessage = error.message;
      } else {
        errorMessage = JSON.stringify(error);
      }
    }

    // Send notification
    console.log(
      `Sending ${isError ? "error" : "success"} notification for ${fileKey}`
    );
    await notifyUser(fileKey, isError, errorMessage, videoUrl);

    console.log("Notification sent successfully");

    // Return the result
    return {
      ...event,
      notificationSent: true,
      notificationSentAt: new Date().toISOString(),
      notificationType: isError ? "error" : "success",
    };
  } catch (error) {
    console.error("Error in notify function:", error);
    throw error;
  }
};
