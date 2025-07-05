import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const REGION = process.env.AWS_REGION || "sa-east-1";
const s3Client = new S3Client({ region: REGION });

// Helper function to ensure execution name doesn't exceed AWS limit
const validateExecutionName = (name) => {
  const MAX_LENGTH = 75;
  if (name.length <= MAX_LENGTH) {
    return name;
  }
  return name.substring(0, MAX_LENGTH);
};

// Helper function to generate execution name with timestamp
const generateExecutionName = (fileKey) => {
  // Clean the fileKey to remove invalid characters for execution names
  const cleanFileKey = fileKey.replace(/[^a-zA-Z0-9\-_]/g, "-");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16); // YYYY-MM-DDTHH-MM
  return validateExecutionName(`sf-${cleanFileKey}-${timestamp}`);
};

// Initialize the Step Functions client
const sfnClient = new SFNClient({
  region: process.env.AWS_REGION || "sa-east-1",
});

// Get the state machine ARN from environment variable
const stateMachineArn = process.env.STATE_MACHINE_ARN;

// Generate random string for fallback title
function generateRandomString(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Inline getObjectMetadata function (from shared layer) with fallbacks
async function getObjectMetadata(bucket, key) {
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    // Extract the x-amz-meta-* headers with fallbacks for testing
    const metadata = {
      contentId: response.Metadata["contentid"] || "1.1",
      type: response.Metadata["type"] || "video",
      title: response.Metadata["title"] || generateRandomString(10),
      parentId: response.Metadata["parentid"] || "1",
      orderIndex: parseInt(response.Metadata["orderindex"] || "1"),
    };

    console.log("Metadata extracted (with fallbacks if needed):", metadata);
    return metadata;
  } catch (error) {
    console.error("Error getting object metadata:", error);
    throw error;
  }
}

export const handler = async (event) => {
  console.log(
    "Initialize function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    // Check if the event is from SQS
    if (event.Records && event.Records[0]?.eventSource === "aws:sqs") {
      const sqsRecord = event.Records[0];
      const s3Event = JSON.parse(sqsRecord.body);

      // Process the S3 event
      const s3Record = s3Event.Records[0];
      const bucketName = s3Record.s3.bucket.name;
      const fileKey = s3Record.s3.object.key;

      console.log(`Processing file ${fileKey} from bucket ${bucketName}`);

      // Get metadata from the S3 object
      const metadata = await getObjectMetadata(bucketName, fileKey);

      // Prepare the execution context that will be passed through the state machine
      const executionContext = {
        fileKey,
        sourceBucket: bucketName,
        outputBucket: process.env.MEDIA_BUCKET || "radioia-media",
        tempPath: `/tmp/${fileKey.split("/").pop()}`,
        audioPath: `/tmp/${fileKey.split("/").pop().split(".")[0]}.mp3`,
        metadata,
        fileExtension: fileKey.split(".").pop().toLowerCase(),
        timestamp: new Date().toISOString(),
      };

      console.log(
        "Created execution context:",
        JSON.stringify(executionContext, null, 2)
      );

      // Start the Step Function execution
      const executionName = generateExecutionName(fileKey);

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(executionContext),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext,
        message: "Step Function execution started successfully",
      };
    } else if (event.fileKey) {
      // Direct invocation (for testing or direct calls)
      // Already has context, start the execution
      const executionName = generateExecutionName(event.fileKey);

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(event),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext: event,
        message: "Step Function execution started successfully",
      };
    } else if (event.Records && event.Records[0]?.eventSource === "aws:s3") {
      // Direct S3 event
      const s3Record = event.Records[0];
      const bucketName = s3Record.s3.bucket.name;
      const fileKey = s3Record.s3.object.key;

      console.log(`Processing file ${fileKey} from bucket ${bucketName}`);

      // Get metadata from the S3 object
      const metadata = await getObjectMetadata(bucketName, fileKey);

      // Prepare the execution context that will be passed through the state machine
      const executionContext = {
        fileKey,
        sourceBucket: bucketName,
        outputBucket: process.env.MEDIA_BUCKET || "radioia-media",
        tempPath: `/tmp/${fileKey.split("/").pop()}`,
        audioPath: `/tmp/${fileKey.split("/").pop().split(".")[0]}.mp3`,
        metadata,
        fileExtension: fileKey.split(".").pop().toLowerCase(),
        timestamp: new Date().toISOString(),
      };

      console.log(
        "Created execution context:",
        JSON.stringify(executionContext, null, 2)
      );

      // Start the Step Function execution
      const executionName = generateExecutionName(fileKey);

      const startExecutionCommand = new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(executionContext),
      });

      const response = await sfnClient.send(startExecutionCommand);

      console.log("Started Step Function execution:", response);

      return {
        statusCode: 200,
        executionArn: response.executionArn,
        executionStartDate: response.startDate,
        executionContext,
        message: "Step Function execution started successfully",
      };
    }

    // If we get here, it's an unsupported event type
    throw new Error("Unsupported event type");
  } catch (error) {
    console.error("Error in initialize function:", error);
    throw error;
  }
};
