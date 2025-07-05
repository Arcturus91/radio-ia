import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import OpenAI from "openai";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || "sa-east-1";
const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ssmClient = new SSMClient({ region: REGION });

// Function to get API key from SSM Parameter Store
async function getOpenAIApiKey() {
  try {
    const command = new GetParameterCommand({
      Name: "/radioia/gemini/api-key",
      WithDecryption: true,
    });
    const response = await ssmClient.send(command);
    return response.Parameter.Value;
  } catch (error) {
    console.error("Error retrieving API key from SSM:", error);
    throw error;
  }
}

let openaiClient = null;

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

const generateHtmlWithOpenAI = async (transcriptedText, _metadata) => {
  try {
    // Initialize OpenAI client if not already done
    if (!openaiClient) {
      console.log("Initializing Gemini client with API key from SSM...");
      const apiKey = await getOpenAIApiKey();
      openaiClient = new OpenAI({ 
        apiKey,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
      });
      console.log("Gemini client initialized successfully");
    }

    const response = await openaiClient.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "You will be given a transcription of a radio show in Spanish. Your task is to generate HTML content based on this transcription.",
            },
          ],
        },
        {
          role: "user",
          content: `Follow these steps:

1. First, read and analyze the following transcription:
<transcription>
${transcriptedText}
</transcription>

2. Generate a brief description of the video content. This description should be between 50 and 80 words long. Capture the main theme and key points discussed in the video.

3. Identify and list 5 topics that a viewer will learn by watching this video. These topics should be concise and reflect the main lessons or insights from the content.

4. Format your response in HTML as follows: (only use Spanish language)
   - Use an <h2> tag for the heading "Descripción de la noticia"
   - Place the brief description in a <p> tag
   - Use an <h3> tag for the heading "Temas"
   - Create an unordered list (<ul>) with 5 list items (<li>) for the topics

Your final output should look like this:

<html>
<h2>Descripción de la noticia</h2>
<p>[Your 50-80 word description here]</p>

<h3>Temas</h3>
<ul>
<li>[Topic 1]</li>
<li>[Topic 2]</li>
<li>[Topic 3]</li>
<li>[Topic 4]</li>
<li>[Topic 5]</li>
</ul>
</html>

Extra considerations that are really important when developing your response:
- The radio show is about a radio show in Uruguay

Ensure that your description and topics accurately reflect the content of the transcription. Be concise and informative in your language.

All your response shall be done in Latin-American Spanish language.

Return only the HTML content, no explanations or additional text.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 1500,
      top_p: 0.8,
      frequency_penalty: 0,
      presence_penalty: 0,
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error("Error generating HTML with OpenAI:", err);
    throw err;
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

    // Generate HTML content using OpenAI
    const htmlContent = await generateHtmlWithOpenAI(
      transcriptedText,
      metadata
    );

    // Save HTML to S3
    const htmlObjectKey = await saveHtmlToS3(key, htmlContent);

    // Update DynamoDB with HTML object key
    await updateDynamoDBWithHtml(contentId, htmlObjectKey);

    console.log("HTML generation completed successfully");

    // Return result for Step Function
    return {
      statusCode: 200,
      htmlObjectKey,
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
