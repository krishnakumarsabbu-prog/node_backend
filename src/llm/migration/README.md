# Migration Mode API

Migration mode enables automatic project migration planning and execution.

## Flow

1. User selects MIGRATE mode
2. Frontend sends request with `chatMode: "migrate"`
3. Backend analyzes project
4. Backend generates migration plan
5. Frontend displays plan to user
6. User clicks "Implement"
7. Frontend sends request with `migrationAction: "implement"` and the plan
8. Backend executes migration
9. Files are updated

## Request Format

### Generate Migration Plan

```typescript
{
  chatMode: "migrate",
  messages: [...],
  files: { ... },
  // No migrationAction or defaults to "plan"
}
```

### Execute Migration Plan

```typescript
{
  chatMode: "migrate",
  migrationAction: "implement",
  migrationPlan: { ... }, // The plan from previous step
  files: { ... }
}
```

## Response Events

### Progress Events

```typescript
{
  type: "progress",
  label: "migration",
  status: "in-progress" | "complete",
  order: number,
  message: string
}
```

### Migration Plan Event

```typescript
{
  type: "migration_plan",
  plan: {
    migrationType: string,
    summary: {
      filesToModify: number,
      filesToDelete: number,
      filesToCreate: number
    },
    tasks: [
      {
        file: string,
        action: "modify" | "delete" | "create",
        description: string
      }
    ]
  }
}
```

### Migration Result Event

```typescript
{
  type: "migration_result",
  result: {
    filesModified: number,
    filesCreated: number,
    filesDeleted: number,
    modifiedFiles: Record<string, string>,
    createdFiles: Record<string, string>,
    deletedFiles: string[]
  }
}
```

## Example Flow

### Step 1: Request Plan

```bash
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
    "web.xml": { "content": "..." },
    "src/UserController.java": { "content": "..." }
  }
}
```

### Step 2: Receive Plan

```
2:{"type":"progress","label":"migration","status":"in-progress","order":1,"message":"Analyzing project"}
2:{"type":"progress","label":"migration","status":"complete","order":2,"message":"Project analysis complete"}
2:{"type":"progress","label":"migration","status":"in-progress","order":3,"message":"Generating migration plan"}
2:{"type":"progress","label":"migration","status":"complete","order":4,"message":"Migration plan generated"}
8:{"type":"migration_plan","plan":{"migrationType":"spring_mvc_to_spring_boot","summary":{"filesToModify":2,"filesToDelete":1,"filesToCreate":1},"tasks":[...]}}
```

### Step 3: Execute Plan

```bash
POST /chat

{
  "chatMode": "migrate",
  "migrationAction": "implement",
  "migrationPlan": { ... }, // The plan from step 2
  "files": { ... }
}
```

### Step 4: Receive Result

```
2:{"type":"progress","label":"migration","status":"in-progress","order":1,"message":"Executing migration tasks"}
2:{"type":"progress","label":"migration","status":"complete","order":2,"message":"Migration completed"}
8:{"type":"migration_result","result":{"filesModified":2,"filesCreated":1,"filesDeleted":1,"modifiedFiles":{...},"createdFiles":{...},"deletedFiles":[...]}}
```

## Supported Migrations

Currently supports:
- Spring MVC to Spring Boot
- Extensible architecture for other migration types

## Implementation Details

- **migrationAnalyzer.ts**: Analyzes project structure and detects framework
- **migrationPlanner.ts**: Uses LLM to generate detailed migration plan
- **migrationExecutor.ts**: Executes plan tasks using LLM for code generation
- **migrationTypes.ts**: TypeScript types and interfaces
