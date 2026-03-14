# Migration Mode Implementation Guide

This document describes the complete implementation of Migration Mode in the chat backend.

## Overview

Migration Mode is a new chat mode that enables automatic project migration planning and execution. It extends the existing `discuss` and `build` modes without modifying their functionality.

## Architecture

### New Files Created

```
src/llm/migration/
├── migrationTypes.ts        - TypeScript type definitions
├── migrationAnalyzer.ts     - Project analysis logic
├── migrationPlanner.ts      - LLM-based migration plan generation
├── migrationExecutor.ts     - Plan execution logic
└── README.md               - API documentation
```

### Modified Files

- `src/routes/chat.ts` - Added migration mode handler
- `src/types/context.ts` - Added migration annotation types
- `src/llm/stream-text.ts` - Added migration mode type
- `package.json` - Added build script

## Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│ User selects MIGRATE mode                           │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Frontend: POST /chat                                │
│ { chatMode: "migrate", messages: [...], files: {...}}│
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Backend: chatHandler                                │
│ - Detects chatMode === "migrate"                    │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Step 1: analyzeProjectForMigration()                │
│ - Detects framework (Spring MVC/Boot, etc.)        │
│ - Identifies build tool (Maven/Gradle)             │
│ - Finds controllers, services, configs             │
│ Progress: "Analyzing project"                       │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Step 2: generateMigrationPlan()                     │
│ - Uses LLM to generate structured plan             │
│ - Returns task list with actions                   │
│ Progress: "Generating migration plan"              │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Stream migration_plan event to frontend            │
│ SSE Event: 8:{"type":"migration_plan","plan":{...}}│
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Frontend displays plan to user                      │
│ User reviews and clicks "Implement"                 │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Frontend: POST /chat                                │
│ { chatMode: "migrate",                              │
│   migrationAction: "implement",                     │
│   migrationPlan: {...} }                            │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Backend: executeMigrationPlan()                     │
│ - Processes each task in plan                       │
│ - Uses LLM to generate code changes                 │
│ - Returns updated files                             │
│ Progress: "Executing migration tasks"              │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ Stream migration_result event                       │
│ Contains: modifiedFiles, createdFiles, deletedFiles│
└─────────────────────────────────────────────────────┘
```

## API Reference

### Request: Generate Plan

```typescript
POST /chat

{
  "chatMode": "migrate",
  "messages": [
    {
      "role": "user",
      "content": "Migrate this Spring MVC project to Spring Boot"
    }
  ],
  "files": {
    "pom.xml": { "content": "..." },
    "web.xml": { "content": "..." }
  }
}
```

### Response: Migration Plan (SSE)

```
2:{"type":"progress","label":"migration","status":"in-progress","order":1,"message":"Analyzing project"}
2:{"type":"progress","label":"migration","status":"complete","order":2,"message":"Project analysis complete"}
2:{"type":"progress","label":"migration","status":"in-progress","order":3,"message":"Generating migration plan"}
2:{"type":"progress","label":"migration","status":"complete","order":4,"message":"Migration plan generated"}
8:{"type":"migration_plan","plan":{ ... }}
```

### Migration Plan Structure

```typescript
{
  "migrationType": "spring_mvc_to_spring_boot",
  "summary": {
    "filesToModify": 10,
    "filesToDelete": 2,
    "filesToCreate": 3
  },
  "tasks": [
    {
      "file": "web.xml",
      "action": "delete",
      "description": "Spring Boot does not require web.xml"
    },
    {
      "file": "pom.xml",
      "action": "modify",
      "description": "Replace spring-webmvc with spring-boot-starter-web"
    },
    {
      "file": "src/main/java/Application.java",
      "action": "create",
      "description": "Create Spring Boot main application class with @SpringBootApplication"
    }
  ]
}
```

### Request: Execute Plan

```typescript
POST /chat

{
  "chatMode": "migrate",
  "migrationAction": "implement",
  "migrationPlan": {
    // The plan from previous step
  },
  "files": { ... }
}
```

### Response: Migration Result (SSE)

```
2:{"type":"progress","label":"migration","status":"in-progress","order":1,"message":"Executing migration tasks"}
2:{"type":"progress","label":"migration","status":"complete","order":2,"message":"Migration completed"}
8:{"type":"migration_result","result":{ ... }}
```

### Migration Result Structure

```typescript
{
  "filesModified": 10,
  "filesCreated": 3,
  "filesDeleted": 2,
  "modifiedFiles": {
    "pom.xml": "<?xml version=\"1.0\"?>...",
    "src/UserController.java": "package com.example..."
  },
  "createdFiles": {
    "src/main/java/Application.java": "package com.example..."
  },
  "deletedFiles": [
    "web.xml",
    "applicationContext.xml"
  ]
}
```

## Type Definitions

### MigrationPlan

```typescript
interface MigrationPlan {
  migrationType: string;
  summary: MigrationSummary;
  tasks: MigrationTask[];
}
```

### MigrationTask

```typescript
interface MigrationTask {
  file: string;
  action: "modify" | "delete" | "create";
  description: string;
}
```

### MigrationResult

```typescript
interface MigrationResult {
  filesModified: number;
  filesCreated: number;
  filesDeleted: number;
  modifiedFiles: Record<string, string>;
  createdFiles: Record<string, string>;
  deletedFiles: string[];
}
```

## Integration with Existing System

### SSE Streaming

Migration mode uses the same SSE streaming infrastructure:
- `writeDataPart()` for progress events
- `writeMessageAnnotationPart()` for plan and result data

### Progress System

Reuses existing progress annotation system:
```typescript
{
  type: "progress",
  label: "migration",
  status: "in-progress" | "complete",
  order: number,
  message: string
}
```

### Context Annotations

New annotation types added:
```typescript
| { type: 'migration_plan'; plan: MigrationPlan }
| { type: 'migration_result'; result: MigrationResult }
```

## Key Design Decisions

1. **Non-invasive**: Does not modify existing `discuss` or `build` logic
2. **Early return**: Migration mode returns before reaching standard streaming logic
3. **Structured output**: LLM generates structured JSON plans, not raw code
4. **Two-phase**: Separate plan generation and execution phases
5. **Streaming**: Uses SSE for real-time progress updates
6. **Safety**: Never overwrites files without explicit plan approval

## Supported Migration Types

Current implementation analyzes and generates plans for:
- Spring MVC to Spring Boot
- Maven and Gradle projects
- XML configuration to Java config

Extensible architecture allows adding:
- Django to FastAPI
- React Class Components to Hooks
- JavaScript to TypeScript
- Any framework migration

## Error Handling

- Invalid JSON from LLM is caught and reported
- Missing files for modification are logged and skipped
- LLM failures in plan generation throw descriptive errors
- All errors are logged with context

## Testing Example

### cURL: Generate Plan

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "chatMode": "migrate",
    "messages": [
      {"role": "user", "content": "Migrate to Spring Boot"}
    ],
    "files": {
      "pom.xml": {"content": "..."}
    },
    "contextOptimization": false,
    "maxLLMSteps": 5,
    "apiKeys": {},
    "providerSettings": {}
  }'
```

### cURL: Execute Plan

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "chatMode": "migrate",
    "migrationAction": "implement",
    "migrationPlan": { ... },
    "files": { ... },
    "contextOptimization": false,
    "maxLLMSteps": 5,
    "apiKeys": {},
    "providerSettings": {}
  }'
```

## Frontend Integration Points

The frontend needs to:

1. Add "migrate" option to chat mode selector
2. Parse `migration_plan` events and display task list
3. Add "Implement" button that sends `migrationAction: "implement"`
4. Parse `migration_result` events and update file tree
5. Handle progress updates for user feedback

## Performance Considerations

- Project analysis is synchronous (fast)
- Plan generation requires one LLM call (2-5 seconds)
- Plan execution requires one LLM call per task (n * 2-5 seconds)
- Large projects with many tasks may take time
- Progress events keep user informed throughout

## Future Enhancements

- Parallel task execution for independent files
- Incremental streaming of completed tasks
- Plan validation before execution
- Rollback capability
- Multi-step migrations (e.g., MVC → Boot → Microservices)
- Custom migration templates
- Dry-run mode showing diffs
