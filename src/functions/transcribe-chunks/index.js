import { OpenAI } from "openai";
import { promises as fs } from "fs";
import { createReadStream, createWriteStream } from "fs";
import { File } from "buffer";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { pipeline } from "stream/promises";

const REGION = process.env.AWS_REGION || "sa-east-1";
const ssmClient = new SSMClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });

// Function to get OpenAI API key for Whisper transcription
async function getOpenAIApiKey() {
  try {
    const command = new GetParameterCommand({
      Name: "/radioia/openai/api-key",
      WithDecryption: true,
    });
    const response = await ssmClient.send(command);
    return response.Parameter.Value;
  } catch (error) {
    console.error("Error retrieving OpenAI API key from SSM:", error);
    throw error;
  }
}

// Function to get Gemini API key for topic analysis
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

let openaiClient = null;
let geminiClient = null;

// Inline S3 utility functions (from shared layer)
async function downloadFileFromS3(bucketName, fileKey, localPath) {
  console.log(`Downloading ${fileKey} from ${bucketName} to ${localPath}...`);

  try {
    const { Body } = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
      })
    );

    await pipeline(Body, createWriteStream(localPath));
    console.log(`Successfully downloaded ${fileKey} to ${localPath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading file ${fileKey} from S3:`, error);
    throw error;
  }
}

async function uploadDataToS3(
  bucketName,
  fileKey,
  data,
  contentType,
  metadata = {}
) {
  console.log(`Uploading data to ${bucketName}/${fileKey}...`);

  try {
    const body = typeof data === "object" ? JSON.stringify(data) : data;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        Body: body,
        ContentType: contentType,
        Metadata: metadata,
      })
    );

    console.log(`Successfully uploaded data to ${bucketName}/${fileKey}`);
    return true;
  } catch (error) {
    console.error("Error uploading data to S3:", error);
    throw error;
  }
}

const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dynamic success threshold based on chunk count
function calculateSuccessThreshold(totalChunks) {
  if (totalChunks <= 3) {
    return 1.0;
  } // 100% - can't lose any with few chunks
  if (totalChunks <= 5) {
    return 0.8;
  } // 80% - lose max 1 chunk
  if (totalChunks <= 10) {
    return 0.7;
  } // 70% - lose max 2-3 chunks
  return Math.max(0.6, 1 - 3 / totalChunks); // Allow max 3 failed chunks, minimum 60%
}

export const handler = async (event) => {
  console.log(
    "Transcribe Chunks function received event:",
    JSON.stringify(event, null, 2)
  );

  try {
    // Initialize OpenAI client if not already done
    if (!openaiClient) {
      console.log("Initializing OpenAI client with API key from SSM...");
      const apiKey = await getOpenAIApiKey();
      openaiClient = new OpenAI({ apiKey });
      console.log("OpenAI client initialized successfully");
    }
    const {
      audioBucket,
      audioKey,
      fileKey,
      outputBucket,
      metadata,
      chunkConfig,
      fileExtension,
    } = event;

    if (
      !audioBucket ||
      !audioKey ||
      !fileKey ||
      !outputBucket ||
      !chunkConfig
    ) {
      throw new Error(
        "Missing required parameters: audioBucket, audioKey, fileKey, outputBucket, or chunkConfig"
      );
    }

    // Define the local audio path
    const audioPath = `/tmp/${audioKey.split("/").pop()}`;

    // Download the audio file from the audio bucket
    console.log(
      `Downloading audio file from ${audioBucket}/${audioKey} to ${audioPath}`
    );
    await downloadFileFromS3(audioBucket, audioKey, audioPath);

    // Extract audio chunks and transcribe with topic analysis
    console.log("Starting enhanced transcription with topic analysis...");
    const enhancedResults = await transcribeAudioWithTopics(
      audioPath,
      chunkConfig.chunkSize,
      chunkConfig.concurrentRequests,
      fileKey
    );

    console.log(
      "Enhanced transcription completed, preparing to upload results"
    );
    console.log("Results summary:", {
      transcription_length: enhancedResults.transcription?.length || 0,
      topic_segments: enhancedResults.topicAnalysis?.segments?.length || 0,
      has_analysis_error: !!enhancedResults.analysisError,
    });

    // Prepare transcription data (only transcription)
    const transcriptionData = {
      transcription: enhancedResults.transcription,
      metadata: {
        original_file: fileKey,
        audio_file: audioKey,
        processed_at: new Date().toISOString(),
      },
      debug: {
        chunks_processed: enhancedResults.transcriptionResults?.length || 0,
        total_segments:
          enhancedResults.transcriptionResults?.reduce(
            (acc, r) => acc + (r.segments?.length || 0),
            0
          ) || 0,
      },
    };

    // Prepare topics data (only topic segments)
    const topicsData = enhancedResults.topicAnalysis
      ? {
          topicSegments: enhancedResults.topicAnalysis.segments || null,
          segmentationMetadata: {
            totalSegments: enhancedResults.topicAnalysis.segments?.length || 0,
            averageSegmentDuration: enhancedResults.topicAnalysis.segments
              ? calculateAverageSegmentDuration(
                  enhancedResults.topicAnalysis.segments
                )
              : 0,
            detectionMethod: "whisper_timestamps_gpt4_analysis",
            analysisError: enhancedResults.analysisError || null,
          },
          metadata: {
            original_file: fileKey,
            audio_file: audioKey,
            processed_at: new Date().toISOString(),
          },
        }
      : null;

    console.log("Final data structure:", {
      has_transcription: !!transcriptionData.transcription,
      transcription_length: transcriptionData.transcription?.length || 0,
      has_topics_data: !!topicsData,
      segments_count: topicsData?.topicSegments?.length || 0,
      has_analysis_error: !!topicsData?.segmentationMetadata?.analysisError,
    });

    // Build metadata for S3 upload
    const s3Metadata = {
      contentid: metadata?.contentId || "",
      type: metadata?.type || "",
      title: metadata?.title || "",
      parentid: metadata?.parentId || "",
      orderindex: (metadata?.orderIndex || 0).toString(),
      fileextension: fileExtension,
      originalobjectkey: fileKey,
      audiokey: audioKey,
    };

    // Upload transcription and topics to separate folders
    const baseFileName = fileKey.includes("/")
      ? fileKey.split("/").pop().split(".")[0]
      : fileKey.split(".")[0];

    // Upload transcription
    const transcriptionKey = `transcription/${baseFileName}.json`;
    await uploadDataToS3(
      outputBucket,
      transcriptionKey,
      transcriptionData,
      "application/json",
      s3Metadata
    );
    console.log(
      `Transcription uploaded to ${outputBucket}/${transcriptionKey}`
    );

    // Upload topics (only if topics were successfully analyzed)
    let topicsKey = null;
    if (topicsData) {
      topicsKey = `topics/${baseFileName}.json`;
      await uploadDataToS3(
        outputBucket,
        topicsKey,
        topicsData,
        "application/json",
        s3Metadata
      );
      console.log(`Topics uploaded to ${outputBucket}/${topicsKey}`);
    } else {
      console.error(
        "No topics data to upload (analysis failed or not performed)"
      );
    }

    // Clean up
    await fs.unlink(audioPath);
    console.log(`Deleted audio file: ${audioPath}`);

    // Return the updated context with enhanced data
    return {
      ...event,
      transcriptionCompleted: true,
      transcriptionCompletedAt: new Date().toISOString(),
      transcription: enhancedResults.transcription,
      topicSegments: enhancedResults.topicAnalysis?.segments || null,
      segmentationCompleted: !!enhancedResults.topicAnalysis,
      segmentationError: enhancedResults.analysisError || null,
      transcriptionKey,
      topicsKey,
      outputKey: transcriptionKey, // For backward compatibility with state machine
    };
  } catch (error) {
    console.error("Error in transcribe-chunks function:", error);
    throw error;
  }
};

async function getAudioFileSize(audioPath) {
  const stats = await fs.stat(audioPath);
  return stats.size;
}

async function getAudioChunk(audioPath, start, end) {
  // Add minimum chunk size verification
  const chunkSize = end - start;
  if (chunkSize < 4096) {
    // If chunk is too small, it might cause format issues
    console.log(`Chunk size ${chunkSize} bytes is too small, skipping...`);
    return null;
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const readStream = createReadStream(audioPath, { start, end: end - 1 });

    readStream.on("data", (chunk) => chunks.push(chunk));
    readStream.on("error", reject);
    readStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function transcribeChunkWithRetry(chunkBuffer, index, retryCount = 0) {
  try {
    const audioFile = new File([chunkBuffer], "chunk.mp3", {
      type: "audio/mp3",
    });
    console.log(`Processing chunk ${index}, attempt ${retryCount + 1}`);

    const transcription = await openaiClient.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "es",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    console.log(`Chunk ${index} transcription completed:`, {
      text_length: transcription.text?.length || 0,
      segments_count: transcription.segments?.length || 0,
      first_segment_start: transcription.segments?.[0]?.start,
      last_segment_end:
        transcription.segments?.[transcription.segments.length - 1]?.end,
    });

    return {
      success: true,
      text: transcription.text,
      segments: transcription.segments,
      duration: transcription.duration,
      index,
    };
  } catch (error) {
    console.error(`Error in transcribeChunkWithRetry chunk ${index}:`, error);

    // Don't retry permanent errors (400 Bad Request)
    if (error.status === 400) {
      console.error(`Permanent error for chunk ${index}: ${error.message}`);
      return { success: false, error, index, permanent: true };
    }

    // Don't retry other permanent errors
    if (error.status === 401 || error.status === 403 || error.status === 413) {
      console.error(
        `Permanent error for chunk ${index} (${error.status}): ${error.message}`
      );
      return { success: false, error, index, permanent: true };
    }

    // Retry transient errors (rate limits, server errors, network issues)
    if (retryCount < MAX_RETRIES) {
      let backoffTime;

      // For rate limits, use reset time from headers if available
      if (error.status === 429) {
        const resetMs = error.headers?.["x-ratelimit-reset-requests"];
        backoffTime = resetMs ? parseInt(resetMs) : 2000;
        console.log(`Rate limited on chunk ${index}, waiting ${backoffTime}ms`);
      } else {
        // Standard exponential backoff for other errors
        backoffTime = Math.pow(2, retryCount) * 1000;
        console.log(`Retrying chunk ${index} after ${backoffTime}ms`);
      }

      await sleep(backoffTime);
      return transcribeChunkWithRetry(chunkBuffer, index, retryCount + 1);
    }

    return { success: false, error, index };
  }
}

// Enhanced version that returns detailed results instead of just joined text
async function getDetailedTranscriptionResults(
  audioPath,
  chunkSize,
  concurrentRequests
) {
  console.log("=== Starting Detailed Transcription Process ===");

  // Use the chunk size from centralized configuration (no override)
  console.log(
    `Using chunk size: ${Math.round(
      chunkSize / 1024 / 1024
    )}MB, concurrency: ${concurrentRequests}`
  );

  // Track memory usage
  const getMemoryUsage = () => {
    const used = process.memoryUsage();
    return Math.round(used.heapUsed / 1024 / 1024);
  };

  console.log(`Initial memory usage: ${getMemoryUsage()}MB`);
  const fileSize = await getAudioFileSize(audioPath);
  let offset = 0;
  const chunks = [];

  // Prepare chunks with configured size
  while (offset < fileSize) {
    const endByte = Math.min(offset + chunkSize, fileSize);
    chunks.push({ start: offset, end: endByte, index: chunks.length });
    offset = endByte;
  }

  console.log(
    `Audio file split into ${chunks.length} chunks of ~${Math.round(
      chunkSize / 1024 / 1024
    )}MB each`
  );

  const transcriptionResults = new Array(chunks.length);
  const failedChunks = [];

  // Process chunks in parallel batches
  for (let i = 0; i < chunks.length; i += concurrentRequests) {
    const batchChunks = chunks.slice(i, i + concurrentRequests);
    console.log(
      `Processing batch ${
        Math.floor(i / concurrentRequests) + 1
      }, memory usage: ${getMemoryUsage()}MB`
    );

    const batchPromises = batchChunks.map(async ({ start, end, index }) => {
      const chunkBuffer = await getAudioChunk(audioPath, start, end);
      if (!chunkBuffer) {
        return null;
      }
      return transcribeChunkWithRetry(chunkBuffer, index);
    });

    const results = await Promise.allSettled(batchPromises);

    // Process results and identify failed chunks
    results.forEach((result, batchIndex) => {
      if (result.status === "fulfilled" && result.value?.success) {
        transcriptionResults[result.value.index] = result.value;
      } else if (result.value) {
        const chunkInfo = chunks[i + batchIndex];
        const errorInfo = result.value;

        // Log different types of failures
        if (errorInfo.permanent) {
          console.error(
            `Chunk ${errorInfo.index} failed permanently: ${errorInfo.error?.message}`
          );
        } else {
          console.error(
            `Chunk ${errorInfo.index} failed after retries: ${errorInfo.error?.message}`
          );
          failedChunks.push(chunkInfo);
        }
      }
    });
  }

  // Count successful vs failed chunks
  const successfulChunks = transcriptionResults.filter(
    (r) => r?.success
  ).length;
  const totalChunks = chunks.length;
  const successRate = ((successfulChunks / totalChunks) * 100).toFixed(1);

  console.log(
    `Processing complete - Success: ${successfulChunks}/${totalChunks} (${successRate}%)`
  );

  // Dynamic threshold based on chunk count
  const requiredThreshold = calculateSuccessThreshold(totalChunks);
  const actualThreshold = successfulChunks / totalChunks;

  console.log(
    `Success threshold: ${(requiredThreshold * 100).toFixed(1)}% (required), ${(
      actualThreshold * 100
    ).toFixed(1)}% (actual)`
  );

  if (actualThreshold < requiredThreshold) {
    console.error(
      `Insufficient success rate: ${successfulChunks}/${totalChunks} (${successRate}%) < ${(
        requiredThreshold * 100
      ).toFixed(1)}% required`
    );
    throw new Error(
      `Transcription failed: ${successfulChunks}/${totalChunks} chunks succeeded, need ${Math.ceil(
        totalChunks * requiredThreshold
      )}`
    );
  } else if (failedChunks.length > 0) {
    console.warn(
      `Some chunks failed (${
        failedChunks.length
      }/${totalChunks}) but meeting ${(requiredThreshold * 100).toFixed(
        1
      )}% threshold`
    );
  }

  console.log(`Final memory usage: ${getMemoryUsage()}MB`);

  return transcriptionResults.filter(Boolean);
}

// Topic Analysis Configuration
const TOPIC_ANALYSIS_CONFIG = {
  minSegmentDuration: 30, // Minimum seconds per topic segment
  maxSegmentDuration: 300, // Maximum seconds per topic segment
  confidenceThreshold: 0.7, // Minimum confidence for topic detection
  enableFallback: true, // Fallback to transcription-only if analysis fails
  maxGptRetries: 2, // Retry attempts for GPT analysis

  // Dynamic topic count based on video duration
  durationBasedTopics: {
    short: { minDuration: 60, maxDuration: 1200, minTopics: 3, maxTopics: 6 }, // 1-20 minutes
    medium: {
      minDuration: 1200,
      maxDuration: 2400,
      minTopics: 5,
      maxTopics: 8,
    }, // 20-40 minutes
    long: {
      minDuration: 2400,
      maxDuration: Infinity,
      minTopics: 8,
      maxTopics: 10,
    }, // 40+ minutes
  },
};

// Helper function to determine topic count based on video duration
function getTopicCountForDuration(durationInSeconds) {
  const duration = Math.floor(durationInSeconds);
  const config = TOPIC_ANALYSIS_CONFIG.durationBasedTopics;

  let category, minTopics, maxTopics;

  if (
    duration >= config.short.minDuration &&
    duration < config.short.maxDuration
  ) {
    category = "short";
    minTopics = config.short.minTopics;
    maxTopics = config.short.maxTopics;
  } else if (
    duration >= config.medium.minDuration &&
    duration < config.medium.maxDuration
  ) {
    category = "medium";
    minTopics = config.medium.minTopics;
    maxTopics = config.medium.maxTopics;
  } else if (duration >= config.long.minDuration) {
    category = "long";
    minTopics = config.long.minTopics;
    maxTopics = config.long.maxTopics;
  } else {
    // For videos under 1 minute, use minimum
    category = "very_short";
    minTopics = 2;
    maxTopics = 3;
  }

  console.log(
    `Video duration: ${formatTime(
      duration
    )} (${duration}s) - Category: ${category} - Topics: ${minTopics}-${maxTopics}`
  );

  return { minTopics, maxTopics, category };
}

// Helper function to format time in MM:SS format
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
}

// Helper function to calculate average segment duration
function calculateAverageSegmentDuration(segments) {
  if (!segments || segments.length === 0) {
    return 0;
  }

  const totalDuration = segments.reduce((acc, segment) => {
    const startParts = segment.startTime.split(":");
    const endParts = segment.endTime.split(":");
    const startSeconds = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    const endSeconds = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
    return acc + (endSeconds - startSeconds);
  }, 0);

  return Math.round(totalDuration / segments.length);
}

// Main topic analysis function
async function analyzeTopicsWithTimestamps(transcriptionResults, fileKey) {
  console.log(`Starting topic analysis for ${fileKey}...`);
  console.log(`Processing ${transcriptionResults.length} transcription chunks`);

  try {
    // Combine all segments with their timestamps
    const allSegments = [];
    let totalOffset = 0;

    transcriptionResults.forEach((result, chunkIndex) => {
      if (result.success && result.segments) {
        console.log(
          `Chunk ${chunkIndex} has ${result.segments.length} segments`
        );

        result.segments.forEach((segment) => {
          allSegments.push({
            text: segment.text,
            start: totalOffset + segment.start,
            end: totalOffset + segment.end,
            chunkIndex: result.index,
          });
        });

        // Update offset for next chunk (assuming chunks are sequential)
        if (result.duration) {
          totalOffset += result.duration;
        }
      }
    });

    console.log(`Total segments collected: ${allSegments.length}`);
    console.log(`Total video duration: ${formatTime(totalOffset)}`);

    // Determine optimal topic count based on video duration
    const { minTopics, maxTopics, category } =
      getTopicCountForDuration(totalOffset);

    // Create timestamped transcript
    const fullTranscriptWithTimestamps = allSegments
      .map(
        (seg) =>
          `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`
      )
      .join("\n");

    console.log(
      `Timestamped transcript length: ${fullTranscriptWithTimestamps.length} characters`
    );
    console.log(
      `Requesting ${minTopics}-${maxTopics} topics for ${category} video`
    );

    const prompt = `
Analiza esta transcripción de video en español con marcas de tiempo e identifica segmentos de temas distintos.

Contexto: Esta es una transcripción de un video noticia de un show de radio en Uruguay.

Transcripción:
${fullTranscriptWithTimestamps}

Devuelve un objeto JSON con segmentos de temas en este formato exacto:
{
  "segments": [
    {
      "startTime": "00:00",
      "endTime": "02:15", 
      "topic": "[Nombre del tema]",
      "description": "[Descripción breve del contenido del segmento]"
    },
    {
      "startTime": "02:15",
      "endTime": "04:30",
      "topic": "[Nombre del tema]", 
      "description": "[Descripción breve del contenido del segmento]"
    }
  ]
}

Instrucciones:
- Identifica entre ${minTopics}-${maxTopics} segmentos de temas principales basándote en el contenido real del video (duración: ${formatTime(
      totalOffset
    )})
- Asegúrate de que no haya espacios de tiempo entre segmentos
- Los nombres de los temas deben reflejar el contenido real del video, no los ejemplos mostrados
- Los temas deben ser relevantes para un show de radio en Uruguay
- Proporciona nombres de temas claros y descriptivos en español
- Incluye descripciones breves del contenido específico de cada segmento
- Los tiempos deben estar en formato MM:SS
- El primer segmento debe comenzar en 00:00
- El último segmento debe terminar en ${formatTime(totalOffset)}
- Para videos más largos, identifica más segmentos temáticos para mejor organización del contenido
`;

    // Initialize Gemini client for topic analysis if not already initialized
    if (!geminiClient) {
      console.log("Initializing Gemini client for topic analysis...");
      const geminiApiKey = await getGeminiApiKey();
      geminiClient = new OpenAI({ 
        apiKey: geminiApiKey,
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
      });
      console.log("Gemini client initialized successfully");
    }

    console.log("Sending topic analysis request to Gemini...");

    const response = await geminiClient.chat.completions.create({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    console.log("GPT-4 response received, parsing JSON...");
    const topicAnalysis = JSON.parse(response.choices[0].message.content);

    console.log("Topic analysis completed:", {
      segments_identified: topicAnalysis.segments?.length || 0,
      topics: topicAnalysis.segments?.map((s) => s.topic) || [],
    });

    return topicAnalysis;
  } catch (error) {
    console.error("Error in topic analysis:", error);
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Enhanced transcription function that includes topic analysis
async function transcribeAudioWithTopics(
  audioPath,
  chunkSize,
  concurrentRequests,
  fileKey
) {
  console.log("=== Enhanced Transcription with Topic Analysis ===");
  console.log(`Audio file: ${audioPath}`);
  console.log(`Chunk size: ${Math.round(chunkSize / 1024 / 1024)}MB`);
  console.log(`Concurrent requests: ${concurrentRequests}`);

  // First, get basic transcription
  const transcriptionResults = await getDetailedTranscriptionResults(
    audioPath,
    chunkSize,
    concurrentRequests
  );

  console.log("Basic transcription completed, starting topic analysis...");

  // Then analyze topics
  let topicAnalysis = null;
  let analysisError = null;

  try {
    topicAnalysis = await analyzeTopicsWithTimestamps(
      transcriptionResults,
      fileKey
    );
  } catch (error) {
    console.warn(
      "Topic analysis failed, proceeding with transcription only:",
      error
    );
    analysisError = error.message;

    if (!TOPIC_ANALYSIS_CONFIG.enableFallback) {
      throw error;
    }
  }

  // Combine results
  const fullTranscription = transcriptionResults
    .filter((result) => result.success)
    .map((result) => result.text)
    .join(" ");

  return {
    transcription: fullTranscription,
    transcriptionResults,
    topicAnalysis,
    analysisError,
  };
}
