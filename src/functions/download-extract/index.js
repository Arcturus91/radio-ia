import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

const REGION = process.env.AWS_REGION || "sa-east-1";
const s3Client = new S3Client({ region: REGION });

// Set the ffmpeg path to the Lambda layer locations
const ffmpegPath = "/opt/bin/ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

// Inline S3 utility functions (from shared layer)
async function downloadFileFromS3(bucketName, fileKey, localPath) {
  console.log(`Downloading ${fileKey} from ${bucketName} to ${localPath}...`);

  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
      }),
    );

    await pipeline(Body, createWriteStream(localPath));
    console.log(`Successfully downloaded ${fileKey} to ${localPath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading file ${fileKey} from S3:`, error);
    throw error;
  }
}

async function uploadFileToS3(bucketName, fileKey, filePath, contentType, metadata = {}) {
  console.log(`Uploading ${filePath} to ${bucketName}/${fileKey}...`);

  try {
    const fileContent = await fs.readFile(filePath);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        Body: fileContent,
        ContentType: contentType,
        Metadata: metadata,
      }),
    );

    console.log(`Successfully uploaded to ${bucketName}/${fileKey}`);
    return true;
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw error;
  }
}

export const handler = async (event) => {
  console.log(
    "Download & Extract function received event:",
    JSON.stringify(event, null, 2),
  );

  try {
    // Extract required parameters
    const { fileKey, sourceBucket, tempPath, audioPath, audioBucket } = event;

    // Validate required parameters
    if (!fileKey || !sourceBucket || !tempPath || !audioPath || !audioBucket) {
      throw new Error(
        "Missing required parameters: fileKey, sourceBucket, tempPath, audioPath, or audioBucket",
      );
    }

    console.log(
      `Processing video ${fileKey} from ${sourceBucket} to audio in ${audioBucket}`,
    );

    // Step 1: Download the video file from S3
    console.log(`Downloading video ${fileKey} from ${sourceBucket} to ${tempPath}`);
    await downloadFileFromS3(sourceBucket, fileKey, tempPath);
    console.log(`Successfully downloaded video to ${tempPath}`);

    // Step 2: Extract audio from video
    console.log(`Extracting audio from ${tempPath} to ${audioPath}`);
    await extractAudio(tempPath, audioPath);

    // Get audio file size
    const audioStats = await fs.stat(audioPath);
    const audioSizeMB = audioStats.size / 1024 / 1024;
    console.log(`Audio file size: ${audioSizeMB.toFixed(2)}MB from original video`);

    // Step 3: Upload the audio file to the target bucket
    // Add audio prefix for centralized bucket structure
    const baseFileName = fileKey.includes("/") ? fileKey.split("/").pop().split(".")[0] : fileKey.split(".")[0];
    const audioKey = `audio/${baseFileName}.mp3`;
    await uploadFileToS3(
      audioBucket,
      audioKey,
      audioPath,
      "audio/mp3",
      { sourceVideo: fileKey },
    );
    console.log(`Successfully uploaded audio to ${audioBucket}/${audioKey}`);

    // Step 4: Clean up the original video file to save space
    await fs.unlink(tempPath);
    console.log(`Deleted original video file: ${tempPath}`);

    // Calculate optimal chunk size based on the audio size
    const chunkConfig = getOptimizedChunkConfig(audioSizeMB);

    // Return the updated context
    return {
      ...event,
      videoDownloaded: true,
      videoDownloadedAt: new Date().toISOString(),
      audioExtracted: true,
      audioExtractedAt: new Date().toISOString(),
      audioSizeMB,
      audioKey,
      chunkConfig,
    };
  } catch (error) {
    console.error("Error in download-extract function:", error);
    throw error;
  }
};

function getOptimizedChunkConfig(audioSizeInMB) {
  // Centralized configuration: 5MB chunks with dynamic concurrency
  const OPTIMAL_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB optimal for reliability
  const MAX_CONCURRENT_REQUESTS = 5; // Maximum concurrent requests

  // Calculate estimated number of chunks
  const estimatedChunks = Math.ceil((audioSizeInMB * 1024 * 1024) / OPTIMAL_CHUNK_SIZE);

  // Dynamic concurrency: don't exceed the number of chunks
  const optimalConcurrency = Math.min(MAX_CONCURRENT_REQUESTS, estimatedChunks);

  const optimalConfig = {
    chunkSize: OPTIMAL_CHUNK_SIZE,
    concurrentRequests: optimalConcurrency,
  };

  console.log(`Optimized config for ${audioSizeInMB}MB audio:`, {
    chunkSizeMB: Math.round(optimalConfig.chunkSize / 1024 / 1024),
    concurrentRequests: optimalConfig.concurrentRequests,
    estimatedChunks,
    strategy: `${estimatedChunks} chunks × ${optimalConcurrency} concurrent`,
  });

  return optimalConfig;
}

function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    let processedSize = 0;

    ffmpeg(videoPath)
      .toFormat("mp3")
      .outputOptions("-vn")
      .outputOptions("-ab", "64k")
      .on("start", (commandLine) => {
        console.log("FFmpeg command:", commandLine);
      })
      .on("progress", (progress) => {
        processedSize = progress.targetSize * 1024;
        console.log(`Processed ${processedSize / 1024 / 1024} MB`);
      })
      .on("error", reject)
      .on("end", resolve)
      .save(audioPath);
  });
}
