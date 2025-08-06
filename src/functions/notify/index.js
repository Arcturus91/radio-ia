import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || "sa-east-1";
const ssmClient = new SSMClient({ region: REGION });

// Cache for SSM parameters to avoid repeated API calls
let cachedParameters = {};

// Function to get parameter from SSM with caching
const getSSMParameter = async (parameterName, withDecryption = false) => {
  if (cachedParameters[parameterName]) {
    return cachedParameters[parameterName];
  }

  try {
    const command = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: withDecryption,
    });
    const response = await ssmClient.send(command);
    cachedParameters[parameterName] = response.Parameter.Value;
    return response.Parameter.Value;
  } catch (error) {
    console.error(`Error retrieving parameter ${parameterName}:`, error);
    throw error;
  }
};

// Function to get all webhook configuration from SSM
const getWebhookConfig = async () => {
  const [webhookUrl, protectionBypass, cloudfrontDomain] = await Promise.all([
    getSSMParameter("/radioia/webhook/url", true),
    getSSMParameter("/radioia/webhook/protection-bypass", true),
    getSSMParameter("/radioia/cloudfront/domain"),
  ]);

  return {
    webhookUrl,
    headers: {
      "Content-Type": "application/json",
      "x-vercel-protection-bypass": protectionBypass,
      "x-vercel-set-bypass-cookie": "true",
    },
    cloudfrontDomain,
  };
};

// Helper function to create CloudFront URLs
const createCloudFrontUrl = (objectKey, cloudfrontDomain) => {
  if (!objectKey) return null;
  return `${cloudfrontDomain}/${objectKey}`;
};

// Webhook payload templates
const createWebhookPayload = (eventType, data) => {
  return {
    eventType,
    timestamp: new Date().toISOString(),
    data,
    source: "radioia-content-processor",
  };
};

async function sendWebhookNotification(
  fileKey,
  isError = false,
  errorMessage = null,
  allContent = null
) {
  try {
    const fileName = fileKey.split("/").pop().split(".")[0];

    // Get webhook configuration from SSM
    console.log("Retrieving webhook configuration from SSM...");
    const webhookConfig = await getWebhookConfig();
    console.log("Webhook configuration retrieved successfully");

    let eventType, data;

    if (isError) {
      eventType = "content.processing.failed";
      data = {
        fileName,
        fileKey,
        error: errorMessage || "Error desconocido",
        message: `Hubo un error al procesar tu archivo ${fileName}`,
        processedAt: new Date().toISOString(),
      };
    } else {
      eventType = "content.processing.completed";

      // Create URLs for all generated content using SSM CloudFront domain
      const contentUrls = {
        videoUrl:
          allContent?.videoUrl ||
          createCloudFrontUrl(fileKey, webhookConfig.cloudfrontDomain),
        audioUrl: createCloudFrontUrl(
          allContent?.audioKey,
          webhookConfig.cloudfrontDomain
        ),
        transcriptionUrl: createCloudFrontUrl(
          allContent?.transcriptionKey,
          webhookConfig.cloudfrontDomain
        ),
        contentUrl: createCloudFrontUrl(
          allContent?.jsonObjectKey,
          webhookConfig.cloudfrontDomain
        ),
        keyphrasesUrl: createCloudFrontUrl(
          allContent?.keyphrasesS3Key,
          webhookConfig.cloudfrontDomain
        ),
        topicsUrl: createCloudFrontUrl(
          allContent?.topicsKey,
          webhookConfig.cloudfrontDomain
        ),
      };

      data = {
        fileName,
        fileKey,
        message: `Tu archivo ${fileName} ha sido procesado exitosamente`,
        processedAt: new Date().toISOString(),

        // Generated content metadata (only title)
        title: allContent?.title,

        // All generated object keys
        objectKeys: {
          video: fileKey,
          audio: allContent?.audioKey,
          transcription: allContent?.transcriptionKey,
          content: allContent?.jsonObjectKey,
          keyphrases: allContent?.keyphrasesS3Key,
          topics: allContent?.topicsKey,
        },

        // CloudFront URLs for easy access
        urls: contentUrls,

        // Legacy fields for backward compatibility
        videoUrl: contentUrls.videoUrl,
        jsonObjectKey: allContent?.jsonObjectKey,
      };
    }

    const payload = createWebhookPayload(eventType, data);

    console.log("Sending webhook payload:", JSON.stringify(payload, null, 2));

    const response = await fetch(webhookConfig.webhookUrl, {
      method: "POST",
      headers: webhookConfig.headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook request failed with status: ${response.status}`);
    }

    console.log(`Webhook notification sent successfully for file: ${fileName}`);
    return true;
  } catch (error) {
    console.error("Error sending webhook notification:", error);
    throw error;
  }
}

export const handler = async (event) => {
  console.log(
    "Notify function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    const {
      fileKey,
      isError = false,
      error,
      videoUrl,
      title,
      description,
      tags,
      keywords,
      jsonObjectKey,
      transcriptionKey,
      keyphrasesS3Key,
      audioKey,
      topicsKey,
    } = event;

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

    // Prepare all content data for successful processing
    const allContent = !isError
      ? {
          videoUrl,
          title,
          description,
          tags,
          keywords,
          jsonObjectKey,
          transcriptionKey,
          keyphrasesS3Key,
          audioKey,
          topicsKey,
        }
      : null;

    // Send webhook notification
    console.log(
      `Sending ${
        isError ? "error" : "success"
      } webhook notification for ${fileKey}`
    );
    console.log("All content data:", JSON.stringify(allContent, null, 2));

    await sendWebhookNotification(fileKey, isError, errorMessage, allContent);

    console.log("Webhook notification sent successfully");

    // Return the result
    return {
      ...event,
      webhookSent: true,
      webhookSentAt: new Date().toISOString(),
      notificationType: isError ? "error" : "success",
    };
  } catch (error) {
    console.error("Error in notify function:", error);
    throw error;
  }
};
