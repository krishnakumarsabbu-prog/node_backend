# Production-Grade Autonomous Migration Engine

## Architecture Overview

This is a production-ready, self-healing AI migration engine built with clean architecture principles, dependency injection, and modular agent design.

## Core Principles

1. **Clean Architecture**: Clear separation of concerns across layers
2. **Dependency Injection**: All dependencies injected through constructors
3. **Modular Agents**: Specialized agents with single responsibilities
4. **Schema Validation**: Zod-based validation for all LLM outputs
5. **Retry Logic**: Exponential backoff for transient failures
6. **Structured Logging**: Scoped loggers for observability
7. **Self-Healing**: Automatic repair loop for build failures

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Migration Runner                      │
│                   (Orchestrator)                        │
└────────────┬────────────────────────────────────────────┘
             │
             ├──► Analyzer Agent ────► Project Analysis
             │
             ├──► Planner Agent ─────► Migration Plan
             │                          (Validated with Zod)
             ├──► Coding Agent ──────► File Operations
             │
             ├──► Migration Executor ─► Apply Changes
             │
             ├──► Verification Agent ─► Build Validation
             │
             └──► Repair Agent ───────► Self-Healing Loop
                     │
                     └─► (Retry up to 5 times)
```

## Module Structure

```
src/migration/
├── agents/
│   ├── analyzerAgent.ts       # Project structure analysis
│   ├── plannerAgent.ts        # LLM-based plan generation
│   ├── codingAgent.ts         # Code generation per file
│   ├── verificationAgent.ts   # Build validation
│   └── repairAgent.ts         # Error repair logic
│
├── core/
│   ├── migrationExecutor.ts   # File operation execution
│   └── migrationRunner.ts     # Main orchestrator
│
├── llm/
│   ├── llmClient.ts           # LLM abstraction with retry
│   └── promptBuilder.ts       # Prompt generation
│
├── schemas/
│   └── migrationSchema.ts     # Zod validation schemas
│
├── types/
│   └── migrationTypes.ts      # TypeScript definitions
│
└── utils/
    └── retry.ts               # Retry utility with backoff
```

## Agent Responsibilities

### 1. Analyzer Agent

**Purpose**: Analyze project structure and detect framework/build tool

**Input**: FileMap (project files)

**Output**: ProjectAnalysis

**Operations**:
- Detect build tool (Maven, Gradle, npm)
- Detect framework (Spring MVC, Spring Boot, Express)
- Categorize files (controllers, services, repositories)
- Find entry points
- Identify configuration files

**No LLM calls** - Pure static analysis

### 2. Planner Agent

**Purpose**: Generate structured migration plan

**Input**:
- FileMap
- ProjectAnalysis
- User request

**Output**: MigrationPlan (Zod-validated)

**Operations**:
- Call LLM with project context
- Parse JSON response
- Validate with MigrationPlanSchema
- Verify tasks against existing files
- Retry on validation failure

**LLM Calls**: 1 (with retry)

### 3. Coding Agent

**Purpose**: Generate code for individual file modifications

**Input**:
- MigrationTask
- Current file content (optional)

**Output**: FileOperation

**Operations**:
- Generate code based on task description
- Clean markdown artifacts from LLM output
- Handle create/modify/delete actions
- Process tasks sequentially

**LLM Calls**: 1 per task (with retry)

### 4. Verification Agent

**Purpose**: Validate build success after migration

**Input**:
- BuildTool
- Work directory

**Output**: BuildValidationResult

**Operations**:
- Execute build command (mvn/gradle/npm)
- Parse build output
- Extract structured errors
- Categorize error types (compilation/dependency/config)
- Return success status

**No LLM calls** - Pure build execution

### 5. Repair Agent

**Purpose**: Fix build errors automatically

**Input**: RepairContext (errors, operations, attempt number)

**Output**: RepairResult (Zod-validated)

**Operations**:
- Analyze build errors
- Generate fixes via LLM
- Validate repair plan with schema
- Track repair attempts
- Decide whether to continue repairs

**LLM Calls**: 1 per repair attempt (with retry)

## Core Components

### Migration Executor

Executes migration plans by:
1. Sorting tasks by priority
2. Processing each task sequentially
3. Applying file operations (modify/create/delete)
4. Tracking changes
5. Building operation history

### Migration Runner

Main orchestrator that:
1. Initializes all agents
2. Coordinates the migration pipeline
3. Handles plan-only or full execution
4. Manages the repair loop
5. Provides configuration options

## LLM Client Abstraction

```typescript
class LLMClient {
  generateWithRetry<T>(
    prompt: string,
    parser: (text: string) => T,
    options: { maxRetries, systemPrompt }
  ): Promise<LLMResponse<T>>

  generateJSON<T>(
    prompt: string,
    validator: (data: unknown) => T,
    options: { maxRetries, systemPrompt }
  ): Promise<LLMResponse<T>>
}
```

**Features**:
- Automatic retry with exponential backoff
- JSON extraction and parsing
- Schema validation integration
- Error tracking
- Configurable timeouts

## Schema Validation

All LLM outputs are validated with Zod:

```typescript
const MigrationPlanSchema = z.object({
  migrationType: z.string().min(1),
  summary: MigrationSummarySchema,
  tasks: z.array(MigrationTaskSchema).min(1),
  estimatedComplexity: z.enum(["low", "medium", "high"]).optional(),
});
```

**Benefits**:
- Type safety
- Runtime validation
- Clear error messages
- Automatic TypeScript type inference

## Retry Policy

Exponential backoff for all LLM calls:

```
Attempt 1: Immediate
Attempt 2: 2 seconds delay
Attempt 3: 4 seconds delay
Max: 10 seconds delay
```

**Retries on**:
- LLM timeout
- Network errors
- JSON parsing failures
- Schema validation failures

## Self-Healing Repair Loop

```typescript
while (attemptNumber <= 5 && buildFails) {
  1. Run build validation
  2. Parse errors
  3. Generate repair via RepairAgent
  4. Apply fixes
  5. Check if errors reduced
  6. Continue if making progress
}
```

**Termination conditions**:
- Build succeeds
- Max attempts (5) reached
- Errors not reducing
- No fixes generated

## Configuration

```typescript
const runner = new MigrationRunner({
  workDir: "/path/to/project",
  enableVerification: true,      // Run builds
  enableAutoRepair: true,         // Auto-fix errors
  maxRepairAttempts: 5,          // Max repair loops
});
```

## Usage Examples

### Generate Plan Only

```typescript
const runner = new MigrationRunner();
const plan = await runner.generatePlanOnly(files, "Migrate to Spring Boot");
```

### Execute Plan

```typescript
const result = await runner.executePlan(plan, files);
```

### Full Migration with Verification

```typescript
const runner = new MigrationRunner({
  enableVerification: true,
  enableAutoRepair: true,
});

const result = await runner.executeMigration({
  files,
  userRequest: "Migrate to Spring Boot",
  workDir: "/project",
  analysis: projectAnalysis,
});
```

## Error Handling

All errors are caught and logged with context:

```typescript
try {
  const plan = await planner.generatePlan(...);
} catch (error) {
  logger.error(`Plan generation failed: ${error.message}`);
  throw error;
}
```

## Logging

Structured logging with scoped loggers:

```
[migration-runner] Starting migration execution
[analyzer-agent] Project analysis complete
[planner-agent] Plan generated: 15 tasks
[coding-agent] Processing task: modify src/Main.java
[verification-agent] Build validation failed with 3 errors
[repair-agent] Repair attempt 1/5 for 3 errors
[migration-runner] Migration complete
```

## Security

**Prevents**:
- Prompt injection (sanitized inputs)
- Path traversal (validated file paths)
- Arbitrary code execution (sandboxed builds)
- Secrets in logs (redaction)

**Only modifies**:
- Files within project directory
- Files specified in plan
- No system files or external paths

## Performance

**Optimizations**:
- Parallel-ready architecture (tasks can be batched)
- Minimal LLM context (file list only, not content)
- Streaming responses
- Task prioritization

**Bottlenecks**:
- Sequential task execution (safety)
- LLM latency (2-5s per call)
- Build validation (project-dependent)

## Testing Strategy

1. **Unit Tests**: Individual agents
2. **Integration Tests**: Full pipeline
3. **Schema Tests**: Validation logic
4. **Retry Tests**: Failure scenarios
5. **Repair Tests**: Self-healing logic

## Production Readiness

✅ Dependency injection
✅ Schema validation
✅ Retry logic
✅ Structured logging
✅ Error handling
✅ Self-healing
✅ Type safety
✅ Modular design
✅ Configuration
✅ Security

## Comparison with Previous Implementation

| Feature | Old System | New System |
|---------|-----------|------------|
| Architecture | Monolithic | Modular agents |
| Dependencies | Direct calls | Injected |
| Validation | None | Zod schemas |
| Retry | Manual | Automatic |
| Build Verification | No | Yes |
| Self-Healing | No | Yes (5 attempts) |
| Logging | Basic | Structured |
| Type Safety | Partial | Complete |
| LLM Abstraction | Direct | Client layer |

## Future Enhancements

1. **Parallel Execution**: Process independent tasks concurrently
2. **Incremental Migration**: Stream completed tasks
3. **Rollback**: Undo failed migrations
4. **Dry-run Mode**: Preview changes without applying
5. **Custom Templates**: User-defined migration patterns
6. **Metrics**: Track success rates and performance
7. **AST Transformations**: Use OpenRewrite/TS-Morph where possible
8. **Caching**: Cache analysis results

## Integration with Chat Handler

The system integrates seamlessly with the existing chat endpoint:

```typescript
// Plan generation
POST /chat { chatMode: "migrate" }
  → Analyzer → Planner → SSE Stream

// Plan execution
POST /chat { chatMode: "migrate", migrationAction: "implement" }
  → Executor → Verifier → Repair Loop → SSE Stream
```

## Conclusion

This is a production-grade autonomous migration engine that follows industry best practices for:

- Clean architecture
- Modular design
- Error resilience
- Observability
- Type safety
- Security

The system can reliably plan, execute, verify, and repair software migrations with minimal human intervention.
