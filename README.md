# lambda-migration-step-functions

## Architecture Overview

This project implements a video processing pipeline using AWS Step Functions with the following components:

1. **Added New S3 Buckets**:
   - `LN-init-processor-video`: Source bucket for videos that triggers the processing workflow
   - `LN-audio-register`: Storage bucket for extracted audio files

2. **Lambda Functions**:
   - Modified `InitializeFunction` to start the Step Function workflow instead of directly processing videos
   - Created a combined `DownloadExtractFunction` that downloads the video and extracts audio
   - Updated `TranscribeChunksFunction` to download audio from the audio bucket
   - Maintained `NotifyFunction` functionality

3. **Step Function Workflow**:
   - Simplified workflow to 3 main steps: Download+Extract → Transcribe → Notify
   - Updated state machine definition to reflect this new flow
   - Added proper error handling and retries

4. **Shared Layer**:
   - Created a shared Lambda layer for common utilities
   - Moved common code like S3 utilities and notification utilities to this layer

5. **Event Triggering**:
   - Configured S3 events from `LN-init-processor-video` to trigger SQS
   - Set up SQS to trigger the `InitializeFunction`
   - The `InitializeFunction` starts the Step Function execution

6. **IAM and Permissions**:
   - Updated IAM roles and policies to support the new workflow
   - Granted access to the new S3 buckets
   - Added permissions for Step Functions execution

This implementation provides a clean workflow that:
1. Receives videos in the `LN-init-processor-video` bucket
2. Processes them through the Step Function
3. Stores intermediate audio files in `LN-audio-register`
4. Generates transcriptions and sends notifications

The approach improves the architecture by consolidating related functions and using a shared layer for common code.# radio-ia
