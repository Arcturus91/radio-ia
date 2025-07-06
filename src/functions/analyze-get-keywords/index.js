import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

import { OpenAI } from "openai";

const REGION = process.env.AWS_REGION || "sa-east-1";
const s3Client = new S3Client({ region: REGION });
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ssmClient = new SSMClient({ region: REGION });

// Function to get API key from SSM Parameter Store
async function getGeminiApiKey() {
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

const CLOUDFRONT_DOMAIN = "d3n0d8f94zelwc.cloudfront.net";
const TABLE_NAME = process.env.TABLE_NAME || "radioIAContent";

const saveKeyphrasesToS3 = async (objectKey, keyphrases) => {
  const bucketName = process.env.MEDIA_BUCKET || "radioia-media";
  const prefix = process.env.KEYPHRASES_PREFIX || "keyphrases/";

  // Extract just the filename from objectKey (remove any path prefixes)
  const baseFileName = objectKey.replace(/^.*\//, "").replace(/\.json$/, "");
  const keyphraseObjectKey = `${prefix}${baseFileName}.json`;
  const objectBody = JSON.stringify({ keyphrases });

  const putObjectParams = {
    Bucket: bucketName,
    Key: keyphraseObjectKey,
    Body: objectBody,
    ContentType: "application/json",
  };

  try {
    await s3Client.send(new PutObjectCommand(putObjectParams));
    console.log("Successfully saved keyphrases to S3");
  } catch (err) {
    console.error("Error saving keyphrases to S3:", err);
    throw err;
  }
};

const checkIfContentIdExists = async (contentId) => {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      contentType: "CONTENT#VIDEO",
      contentId,
    },
  };

  try {
    const { Item } = await docClient.send(new GetCommand(params));
    return Item || null;
  } catch (error) {
    console.error("Error checking if contentId exists:", error);
    throw error;
  }
};

/**
 * Validates if a content position (parentId.orderIndex) is available in DynamoDB
 * If not available, finds the next sequential slot within the same parent
 *
 * @param {string} parentId - The parent ID from metadata
 * @param {number} orderIndex - The order index from metadata
 * @returns {Object} - { contentId, available, adjustedOrderIndex? }
 */
const validateContentPosition = async (parentId, orderIndex) => {
  console.log(
    `Validating content position for parentId: ${parentId}, orderIndex: ${orderIndex}`
  );

  // Construct the intended contentId
  const intendedContentId = `${parentId}.${orderIndex}`;

  try {
    // Check if the intended position is available
    const existingItem = await checkIfContentIdExists(intendedContentId);

    if (!existingItem) {
      console.log(`Position ${intendedContentId} is available`);
      return {
        contentId: intendedContentId,
        available: true,
      };
    }

    console.log(
      `Position ${intendedContentId} is taken, searching for next available slot...`
    );

    // Position is taken - find next available slot within the same parent
    let candidateOrderIndex = orderIndex + 1;
    let attempts = 0;
    const MAX_ATTEMPTS = 100; // Prevent infinite loops

    while (attempts < MAX_ATTEMPTS) {
      const candidateContentId = `${parentId}.${candidateOrderIndex}`;

      console.log(`Checking candidate position: ${candidateContentId}`);

      const candidateExists = await checkIfContentIdExists(candidateContentId);

      if (!candidateExists) {
        console.log(`Found available position: ${candidateContentId}`);
        return {
          contentId: candidateContentId,
          available: true,
          adjustedOrderIndex: candidateOrderIndex,
          originalOrderIndex: orderIndex,
        };
      }

      candidateOrderIndex++;
      attempts++;
    }

    // If we reach here, we couldn't find an available slot
    throw new Error(
      `Cannot find available content position for parentId '${parentId}' after ${MAX_ATTEMPTS} attempts. ` +
        `Started from orderIndex ${orderIndex}, checked up to ${
          candidateOrderIndex - 1
        }.`
    );
  } catch (error) {
    console.error(
      `Error validating content position for ${parentId}.${orderIndex}:`,
      error
    );
    throw error;
  }
};

const saveToDynamoDB = async (metadata, transcriptionS3Key, topicsKey) => {
  console.log("Metadata structure:", JSON.stringify(metadata, null, 2));
  console.log("Transcription S3 key:", transcriptionS3Key);

  if (!metadata.videoKey) {
    throw new Error(
      `Missing videoKey in metadata: ${JSON.stringify(metadata)}`
    );
  }

  if (!metadata.parentId || metadata.orderIndex === undefined) {
    throw new Error(
      `Missing parentId or orderIndex in metadata: ${JSON.stringify(metadata)}`
    );
  }

  const videoKeyArray = metadata.videoKey.split(".");
  // Remove "video/" prefix if present before saving to DynamoDB
  const videoKey = videoKeyArray[0].replace(/^video\//, "");
  const _fileExtension = videoKeyArray[1]; // Prefix with _ to indicate intentionally unused

  // Validate the intended content position and find available slot
  const positionResult = await validateContentPosition(
    metadata.parentId,
    metadata.orderIndex
  );

  const finalContentId = positionResult.contentId;
  const finalOrderIndex =
    positionResult.adjustedOrderIndex || metadata.orderIndex;

  if (positionResult.adjustedOrderIndex) {
    console.log(
      `Original position ${metadata.parentId}.${metadata.orderIndex} taken, ` +
        `using available position ${finalContentId}`
    );
  } else {
    console.log(`Using intended position ${finalContentId}`);
  }

  const item = {
    contentType: "CONTENT#VIDEO",
    contentId: finalContentId, // Use the validated contentId
    createdAt: new Date().toISOString(),
    keywordsRegistered: false,
    orderIndex: finalOrderIndex, // Use the adjusted orderIndex if position was taken
    parentId: metadata.parentId,
    title: decodeURIComponent(metadata.title),
    type: metadata.type,
    videoKey,
    videoUrl: `https://${CLOUDFRONT_DOMAIN}/${metadata.videoKey}`,
    topicSegments: topicsKey,
  };

  console.log("Saving to DynamoDB:", item);

  // Use a condition expression to ensure it doesn't overwrite
  const params = {
    TableName: TABLE_NAME,
    Item: item, // Document client handles marshalling automatically
    ConditionExpression: "attribute_not_exists(contentId)", // Only write if contentId doesn't exist
  };

  try {
    await docClient.send(new PutCommand(params));
    console.log(
      `Successfully saved to DynamoDB with contentId: ${finalContentId}`
    );
    return finalContentId; // Return the final validated contentId
  } catch (error) {
    // If condition check fails, it means there's a race condition
    if (error instanceof ConditionalCheckFailedException) {
      console.log(
        "Race condition detected, retrying with next available position"
      );
      // Retry with the next orderIndex to handle race conditions
      const retryMetadata = {
        ...metadata,
        orderIndex: finalOrderIndex + 1,
      };
      return saveToDynamoDB(retryMetadata, transcriptionS3Key, topicsKey);
    }
    console.error("Error saving to DynamoDB:", error);
    throw error;
  }
};

const processWithGemini = async (transcriptedText) => {
  try {
    // Initialize Gemini client if not already done - matching your working pattern
    if (!openaiClient) {
      console.log("Initializing Gemini client with API key from SSM...");
      const apiKey = await getGeminiApiKey();

      // Use the same pattern as your working transcription code
      openaiClient = new OpenAI({
        apiKey: apiKey,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      });

      console.log("Gemini client initialized successfully");
    }

    const response = await openaiClient.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [
        {
          role: "system",
          content:
            "You are tasked with extracting the main keyphrases from an audio transcription. This transcription is from a radio show in Uruguay.",
        },
        {
          role: "user",
          content: `Please follow these steps to complete the task:

1. Carefully read through the entire transcription.
2. Identify the main topics and themes discussed in the transcription.
3. Extract keyphrases that best represent these topics. Keyphrases can be composed of one, two, or three words.
4. Aim to find 20 keyphrases. If there are fewer than 20 distinct main topics, you may include secondary or related topics to reach the target number.
5. Ensure that the keyphrases are relevant to the context of a radio show in Uruguay.

Here is the audio transcription:
${transcriptedText}

Output your list of keyphrases in the following format and in Spanish language:
<keyphrases>
- Keyphrase 1
- Keyphrase 2
- Keyphrase 3
...
- Keyphrase 20
</keyphrases>

Additional guidelines:
- Separate each keyphrase with a hyphen and a space ("- ").
- Start each keyphrase with a capital letter.
- Do not use punctuation at the end of the keyphrases.
- Ensure that each keyphrase is unique and not a repetition of another.
- If you absolutely cannot find 20 unique keyphrases, provide as many as you can, but try to reach the target number by considering broader themes or related concepts.

Remember, the goal is to capture the essence of the transcription in these keyphrases, focusing on topics related to a radio show in Uruguay.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 403,
      top_p: 0.69,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error("Error processing with Gemini:", err);
    throw err;
  }
};

const parseKeyphrasesResponse = (geminiResponse) => {
  try {
    const matches = geminiResponse.match(
      /<keyphrases>([\s\S]*?)<\/keyphrases>/
    );

    if (!matches || !matches[1]) {
      throw new Error("No keyphrases tags found in the response");
    }

    const content = matches[1].trim();

    const keyphrases = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.substring(2).trim())
      .filter((keyphrase) => keyphrase.length > 0);

    return keyphrases;
  } catch (error) {
    console.error("Error parsing keyphrases:", error);
    throw error;
  }
};

export const handler = async (event) => {
  console.log(
    "Analyze-get-keywords function received event:",
    JSON.stringify(event, null, 2)
  );

  // Extract data from Step Function payload
  console.log("Processing Step Function event");
  const transcriptedText = event.transcription;
  const metadata = event.metadata;
  const key = event.outputKey || event.fileKey;

  // Get the transcription S3 key to save in DynamoDB
  const transcriptionS3Key = event.transcriptionKey || event.outputKey; // Use new transcriptionKey or fallback to outputKey
  const topicsKey = event.topicsKey;

  // Add missing videoKey to metadata using fileKey if not present
  if (event.fileKey && !metadata.videoKey) {
    metadata.videoKey = event.fileKey;
    console.log("Constructed videoKey for Step Function:", metadata.videoKey);
  }

  if (!transcriptedText || !topicsKey) {
    throw new Error(
      "Missing transcription or topics S3 key in Step Function payload"
    );
  }

  try {
    console.log(
      "Processing with transcription length:",
      transcriptedText.length
    );
    console.log("Transcription S3 key to save:", transcriptionS3Key);
    console.log("Topics S3 key to save:", topicsKey);
    const finalContentID = await saveToDynamoDB(
      metadata,
      transcriptionS3Key,
      topicsKey
    );
    console.log("Final contentID saved:", finalContentID);

    // Process with Gemini
    const geminiResponse = await processWithGemini(transcriptedText);
    const parsedKeyphrases = parseKeyphrasesResponse(geminiResponse);

    // Save keyphrases to S3
    await saveKeyphrasesToS3(key, parsedKeyphrases);

    // Construct video URL for notification
    const videoUrl = `https://${CLOUDFRONT_DOMAIN}/${metadata.videoKey}`;

    // Return result for Step Function
    return {
      statusCode: 200,
      contentId: finalContentID,
      keyphrases: parsedKeyphrases,
      message:
        "Successfully processed text, saved keyphrases, and updated DynamoDB",
      // Pass through data for Step Functions
      fileKey: key,
      metadata,
      videoUrl,
      transcription: transcriptedText, // Pass through transcription for HTML generator
      outputKey: key, // Pass through for HTML generator
    };
  } catch (err) {
    console.error("Error in handler:", err);
    throw err;
  }
};
