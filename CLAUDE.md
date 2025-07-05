# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Build and Deployment
- **Build**: `sam build` - Builds all Lambda functions and the Step Functions state machine
- **Deploy**: `sam deploy --stack-name radioia-content-processor --capabilities CAPABILITY_IAM` - Deploys the complete stack to AWS
- **Package**: `sam package --output-template-file packaged.yml --s3-bucket radioia-deployments` - Packages for deployment

### Testing and Quality
- **Lint**: `npm run lint` - Runs ESLint across the codebase
- **Test**: `npm run test` - Runs Jest test suite

## Architecture Overview

This is an advanced AWS serverless video processing pipeline specialized for masculinity coaching content. The system processes Spanish-language videos through audio extraction, transcription, and intelligent topic segmentation.

### Core Components

**Step Functions State Machine** (`statemachine.asl.yml`):
- **DownloadAndExtract**: Downloads video from S3, extracts audio using FFmpeg, uploads audio to separate bucket
- **TranscribeChunks**: Enhanced transcription with GPT-4 topic analysis and timestamp-based segmentation  
- **NotifySuccess/HandleError**: Sends Spanish language notifications via SNS for success or failure

**Lambda Functions** (all use Node.js 20.x):
- `InitializeFunction`: Triggered by SQS from S3 events, starts Step Function execution with metadata extraction and execution name validation
- `DownloadExtractFunction`: Combined video download and audio extraction (uses FFmpeg layer, optimizes chunk sizing)
- `TranscribeChunksFunction`: **Advanced transcription with topic analysis** - uses Whisper + GPT-4o for intelligent segmentation
- `NotifyFunction`: SNS notifications for success/error states (Spanish language templates)

**S3 Buckets**:
- `ln-init-processor-video`: Source bucket for video uploads (triggers workflow)
- `ln-audio-register`: Intermediate storage for extracted audio files  
- `radioia-transcripts`: Final output bucket for enhanced transcription results with topic segments

**Shared Layer** (`src/functions/shared-layer/`):
- Common utilities for S3 operations and notifications
- Used across all Lambda functions to avoid code duplication

### Enhanced Transcription Features

**TranscribeChunksFunction** is the most advanced component with:

**Core Transcription**:
- OpenAI Whisper API with `verbose_json` format for timestamp granularity
- Spanish language optimization (`language: "es"`) 
- Chunked processing with intelligent batch concurrency
- SSM Parameter Store integration for secure API key management

**GPT-4 Topic Analysis**:
- Analyzes complete timestamped transcript to identify topic changes
- Dynamic topic count based on video duration:
  - 1-20 minutes: 3-6 topics
  - 20-40 minutes: 5-8 topics  
  - 40+ minutes: 8-10 topics
- Content-aware prompts optimized for masculinity coaching content (men 30s-50s)
- Precise MM:SS timestamp formatting

**Output Structure**:
```json
{
  "transcription": "Complete Spanish transcript",
  "topicSegments": [
    {
      "startTime": "00:00",
      "endTime": "02:15", 
      "topic": "Confianza y Autoestima",
      "description": "Discusión sobre cómo desarrollar confianza personal"
    }
  ],
  "segmentationMetadata": {
    "totalSegments": 5,
    "averageSegmentDuration": 120,
    "detectionMethod": "whisper_timestamps_gpt4_analysis"
  }
}
```

### Key Architectural Patterns

**Event Flow**: S3 → SQS → Initialize Lambda → Step Functions → (Download+Extract → Enhanced Transcribe+Topics → Notify)

**Execution Management**:
- Step Functions execution names include timestamp for uniqueness and traceability
- Automatic validation and truncation to AWS 80-character limit
- Format: `sf-{fileKey}-{timestamp}` (e.g., `sf-video/sample.mp4-2024-01-15T10-30`)

**Error Handling**: 
- Lambda-level retry logic with exponential backoff
- Step Functions state-based retry policies
- Graceful fallback if topic analysis fails (continues with basic transcription)
- Dead letter queue for failed messages

**Resource Optimization**: 
- Dynamic audio chunking based on file size (4MB-20MB chunks)
- Intelligent concurrent processing (2-4 parallel requests)
- Memory usage monitoring and cleanup
- Optimized timeout and memory settings per function

**Security**:
- SSM Parameter Store for OpenAI API key (`/radioia/gemini/api-key`)
- KMS encryption for sensitive parameters
- IAM least privilege access

### Content Specialization

**Target Content**: Masculinity coaching videos for men aged 30-50
**Language**: Spanish language optimization throughout
**Topic Detection**: Tailored for relationship and self-improvement content
**Output**: Structured for content analysis and organization

## Important Configuration

**Environment Variables**:
- `STATE_MACHINE_ARN`: Used by InitializeFunction to start executions
- `AUDIO_BUCKET`: Target bucket for extracted audio files
- `OPENAI_API_KEY`: Retrieved from SSM Parameter Store (`/radioia/gemini/api-key`)

**IAM Permissions**: Shared role with permissions for S3, SNS, SSM (with KMS decrypt), and Step Functions

**Lambda Layers**: 
- Custom FFmpeg layer for video processing
- OpenAI layer for API integration  
- Shared utilities layer for common functions
- Node.js dependencies layer

**External Services**:
- OpenAI Whisper API for transcription
- GPT-4o for topic analysis
- AWS SNS for notifications
- AWS SSM for secure configuration

## Recent Updates

### Execution Name Management (Latest)
- **Enhanced InitializeFunction**: Added helper functions for execution name validation and timestamp generation
- **Timestamp Integration**: Execution names now include datetime for better traceability
- **AWS Compliance**: Automatic truncation to 80-character limit with fallback mechanisms
- **Format**: `sf-{fileKey}-{YYYY-MM-DDTHH-MM}` with intelligent truncation

### Code Analysis Documentation
- **Comprehensive Analysis**: Detailed technical documentation of the TranscribeChunksFunction
- **Architecture Review**: In-depth analysis of AI processing pipeline and security implementation
- **Performance Metrics**: Memory usage, processing times, and resource optimization details

## Current Status: Production Ready ✅

The video processing pipeline is fully operational with:
- ✅ Enhanced transcription with topic analysis
- ✅ Robust execution name management 
- ✅ Comprehensive error handling and fallbacks
- ✅ Spanish language optimization for coaching content
- ✅ Scalable architecture with monitoring capabilities