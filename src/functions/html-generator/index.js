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

const saveJsonToS3 = async (objectKey, jsonContent) => {
  const bucketName = process.env.MEDIA_BUCKET || "radioia-media";
  const prefix = process.env.JSON_PREFIX || "content/";

  // Extract just the filename from objectKey (remove any path prefixes)
  const baseFileName = objectKey.replace(/^.*\//, "").replace(/\.json$/, "");
  const jsonObjectKey = `${prefix}${baseFileName}.json`;

  const putObjectParams = {
    Bucket: bucketName,
    Key: jsonObjectKey,
    Body: JSON.stringify(jsonContent, null, 2),
    ContentType: "application/json",
  };

  try {
    await s3Client.send(new PutObjectCommand(putObjectParams));
    console.log("Successfully saved JSON content to S3");
    return jsonObjectKey;
  } catch (err) {
    console.error("Error saving JSON content to S3:", err);
    throw err;
  }
};

const updateDynamoDBWithJson = async (contentId, jsonObjectKey) => {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      contentType: "CONTENT#VIDEO",
      contentId,
    },
    UpdateExpression: "SET jsonContent = :jsonContent",
    ExpressionAttributeValues: {
      ":jsonContent": jsonObjectKey,
    },
  };

  try {
    await docClient.send(new UpdateCommand(params));
    console.log(
      `Successfully updated DynamoDB with JSON content for contentId: ${contentId}`
    );
  } catch (error) {
    console.error("Error updating DynamoDB with JSON content:", error);
    throw error;
  }
};

// FIXED: Consistent function naming and initialization pattern
const generateContentWithGemini = async (transcriptedText, metadata) => {
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

    console.log("Sending content generation request to Gemini...");

    const response = await geminiClient.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "system",
          content:
            "Eres un experto en crear resúmenes de contenido para programas de radio en Uruguay. Tu tarea es generar contenido estructurado basado en transcripciones de audio.",
        },
        {
          role: "user",
          content: `Analiza esta transcripción de un programa de radio uruguayo y genera contenido estructurado:

Transcripción:
${transcriptedText}

Genera contenido estructurado que incluya:
1. Un título atractivo para el contenido
2. Una descripción de 50-80 palabras sobre el contenido principal
3. Una lista de 5 temas principales que se discuten (tags)
4. Las palabras clave más relevantes

Formato de respuesta JSON:
{
  "title": "Título atractivo para el contenido",
  "description": "Descripción de 50-80 palabras del contenido principal",
  "tags": [
    "Tema 1",
    "Tema 2", 
    "Tema 3",
    "Tema 4",
    "Tema 5"
  ],
  "keywords": [
    "palabra1",
    "palabra2",
    "palabra3"
  ]
}

Instrucciones importantes:
- Escribe en español rioplatense (Uruguay/Argentina)
- Enfócate en temas relevantes para audiencia uruguaya
- La descripción debe capturar la esencia del programa
- Los tags deben ser específicos y educativos
- El título debe ser atractivo y descriptivo
- No incluyas explicaciones adicionales, solo el JSON solicitado`,
        },
      ],
      response_format: { type: "json_object" }, // FIXED: Consistent structured output
      temperature: 0.3, // FIXED: Consistent temperature with other functions
    });

    console.log("Gemini content generation response received");
    return response.choices[0].message.content;
  } catch (err) {
    console.error("Error generating content with Gemini:", err);
    throw err;
  }
};

// ADDED: Consistent response parsing
const parseContentResponse = (geminiResponse) => {
  try {
    console.log("Parsing Gemini content response...");
    const parsedResponse = JSON.parse(geminiResponse);

    if (!parsedResponse.title) {
      throw new Error("Invalid response format: missing title field");
    }

    if (!parsedResponse.description || !parsedResponse.tags) {
      console.warn(
        "Response missing description or tags, but title is present"
      );
    }

    console.log("Successfully parsed content response");
    return {
      title: parsedResponse.title,
      description: parsedResponse.description,
      tags: parsedResponse.tags || [],
      keywords: parsedResponse.keywords || [],
    };
  } catch (error) {
    console.error("Error parsing content JSON response:", error);
    throw new Error("Failed to parse content from response");
  }
};

export const handler = async (event) => {
  console.log(
    "Content generator function received event:",
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
      "Generating content with transcription length:",
      transcriptedText.length
    );

    // Generate content using Gemini with consistent pattern
    const geminiResponse = await generateContentWithGemini(
      transcriptedText,
      metadata
    );
    const parsedResult = parseContentResponse(geminiResponse);

    // Create complete content object
    const contentData = {
      title: parsedResult.title,
      description: parsedResult.description,
      tags: parsedResult.tags,
      keywords: parsedResult.keywords,
      metadata: metadata,
      generatedAt: new Date().toISOString(),
    };

    // Save JSON to S3
    const jsonObjectKey = await saveJsonToS3(key, contentData);

    // Update DynamoDB with JSON object key
    await updateDynamoDBWithJson(contentId, jsonObjectKey);

    console.log("Content generation completed successfully");

    // Return result for Step Function
    return {
      statusCode: 200,
      jsonObjectKey,
      title: parsedResult.title,
      description: parsedResult.description,
      tags: parsedResult.tags,
      keywords: parsedResult.keywords,
      message: "Successfully generated JSON content and updated DynamoDB",
      // Pass through data for Step Functions
      fileKey: key,
      metadata,
      contentId,
      transcription: transcriptedText,
      keyphrases: event.keyphrases,
      videoUrl: event.videoUrl,
      // Pass through object keys from previous steps
      transcriptionKey: event.transcriptionKey,
      audioKey: event.audioKey,
      topicsKey: event.topicsKey,
      outputKey: event.outputKey,
    };
  } catch (err) {
    console.error("Error in content generator handler:", err);
    throw err;
  }
};
