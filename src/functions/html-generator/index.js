import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { OpenAI } from "openai"; // FIXED: Consistent import syntax
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || "sa-east-1";
const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ssmClient = new SSMClient({ region: REGION });

// FIXED: Consistent function naming and comments
// Function to get Gemini API key from SSM Parameter Store
async function getGeminiApiKey() {
  try {
    const command = new GetParameterCommand({
      Name: "/radioia/gemini/api-key",
      WithDecryption: true,
    });
    const response = await ssmClient.send(command);
    return response.Parameter.Value;
  } catch (error) {
    console.error("Error retrieving Gemini API key from SSM:", error);
    throw error;
  }
}

// FIXED: Consistent client naming
let geminiClient = null;

const TABLE_NAME = process.env.TABLE_NAME || "radioIAContent";

const saveHtmlToS3 = async (objectKey, htmlContent) => {
  const bucketName = process.env.MEDIA_BUCKET || "radioia-media";
  const prefix = process.env.HTML_PREFIX || "html/";

  // Extract just the filename from objectKey (remove any path prefixes)
  const baseFileName = objectKey.replace(/^.*\//, "").replace(/\.json$/, "");
  const htmlObjectKey = `${prefix}${baseFileName}.html`;

  const putObjectParams = {
    Bucket: bucketName,
    Key: htmlObjectKey,
    Body: htmlContent,
    ContentType: "text/html",
  };

  try {
    await s3Client.send(new PutObjectCommand(putObjectParams));
    console.log("Successfully saved HTML content to S3");
    return htmlObjectKey;
  } catch (err) {
    console.error("Error saving HTML content to S3:", err);
    throw err;
  }
};

const updateDynamoDBWithHtml = async (contentId, htmlObjectKey) => {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      contentType: "CONTENT#VIDEO",
      contentId,
    },
    UpdateExpression: "SET htmlContent = :htmlContent",
    ExpressionAttributeValues: {
      ":htmlContent": htmlObjectKey,
    },
  };

  try {
    await docClient.send(new UpdateCommand(params));
    console.log(
      `Successfully updated DynamoDB with HTML content for contentId: ${contentId}`
    );
  } catch (error) {
    console.error("Error updating DynamoDB with HTML content:", error);
    throw error;
  }
};

// FIXED: Consistent function naming and initialization pattern
const generateHtmlWithGemini = async (transcriptedText, metadata) => {
  try {
    // Initialize Gemini client if not already done - EXACTLY matching other functions
    if (!geminiClient) {
      console.log("Initializing Gemini client for HTML generation...");
      const geminiApiKey = await getGeminiApiKey();
      geminiClient = new OpenAI({
        apiKey: geminiApiKey,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      });
      console.log("Gemini client initialized successfully");
    }

    console.log("Sending HTML generation request to Gemini...");

    const response = await geminiClient.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "system",
          content:
            "Eres un experto en crear resúmenes de contenido para programas de radio en Uruguay. Tu tarea es generar contenido HTML estructurado basado en transcripciones de audio.",
        },
        {
          role: "user",
          content: `Analiza esta transcripción de un programa de radio uruguayo y genera contenido HTML estructurado:

Transcripción:
${transcriptedText}

Genera contenido HTML que incluya:
1. Una descripción de 50-80 palabras sobre el contenido principal
2. Una lista de 5 temas principales que se discuten

Formato de respuesta JSON:
{
  "description": "Descripción de 50-80 palabras del contenido principal",
  "topics": [
    "Tema 1",
    "Tema 2", 
    "Tema 3",
    "Tema 4",
    "Tema 5"
  ],
  "html": "<h2>Descripción de la noticia</h2><p>...</p><h3>Temas</h3><ul><li>...</li></ul>"
}

Instrucciones importantes:
- Escribe en español rioplatense (Uruguay/Argentina)
- Enfócate en temas relevantes para audiencia uruguaya
- La descripción debe capturar la esencia del programa
- Los temas deben ser específicos y educativos
- El HTML debe estar bien formateado y ser válido
- No incluyas explicaciones adicionales, solo el JSON solicitado`,
        },
      ],
      response_format: { type: "json_object" }, // FIXED: Consistent structured output
      temperature: 0.3, // FIXED: Consistent temperature with other functions
    });

    console.log("Gemini HTML generation response received");
    return response.choices[0].message.content;
  } catch (err) {
    console.error("Error generating HTML with Gemini:", err);
    throw err;
  }
};

// ADDED: Consistent response parsing
const parseHtmlResponse = (geminiResponse) => {
  try {
    console.log("Parsing Gemini HTML response...");
    const parsedResponse = JSON.parse(geminiResponse);

    if (!parsedResponse.html) {
      throw new Error("Invalid response format: missing html field");
    }

    if (!parsedResponse.description || !parsedResponse.topics) {
      console.warn(
        "Response missing description or topics, but HTML is present"
      );
    }

    console.log("Successfully parsed HTML response");
    return {
      html: parsedResponse.html,
      description: parsedResponse.description,
      topics: parsedResponse.topics,
    };
  } catch (error) {
    console.error("Error parsing HTML JSON response:", error);

    // Fallback: try to extract HTML directly if it's raw HTML
    console.log("Attempting fallback HTML extraction...");
    if (geminiResponse.includes("<h2>") && geminiResponse.includes("</html>")) {
      console.log("Found raw HTML in response, using directly");
      return {
        html: geminiResponse,
        description: null,
        topics: null,
      };
    }

    throw new Error("Failed to parse HTML from response");
  }
};

export const handler = async (event) => {
  console.log(
    "HTML generator function received event:",
    JSON.stringify(event, null, 2)
  );

  // Extract data from Step Function payload
  console.log("Processing Step Function event");
  const transcriptedText = event.transcription;
  const metadata = event.metadata;
  const key = event.outputKey || event.fileKey;
  const contentId = event.contentId;

  if (!transcriptedText || !contentId) {
    throw new Error(
      "Missing transcription or contentId in Step Function payload"
    );
  }

  try {
    console.log(
      "Generating HTML with transcription length:",
      transcriptedText.length
    );

    // Generate HTML content using Gemini with consistent pattern
    const geminiResponse = await generateHtmlWithGemini(
      transcriptedText,
      metadata
    );
    const parsedResult = parseHtmlResponse(geminiResponse);

    // Save HTML to S3
    const htmlObjectKey = await saveHtmlToS3(key, parsedResult.html);

    // Update DynamoDB with HTML object key
    await updateDynamoDBWithHtml(contentId, htmlObjectKey);

    console.log("HTML generation completed successfully");

    // Return result for Step Function
    return {
      statusCode: 200,
      htmlObjectKey,
      htmlContent: parsedResult.html,
      description: parsedResult.description,
      topics: parsedResult.topics,
      message: "Successfully generated HTML content and updated DynamoDB",
      // Pass through data for Step Functions
      fileKey: key,
      metadata,
      contentId,
      transcription: transcriptedText,
      keyphrases: event.keyphrases,
      videoUrl: event.videoUrl,
    };
  } catch (err) {
    console.error("Error in HTML generator handler:", err);
    throw err;
  }
};
