import { generateText, type CoreTool, type GenerateTextResult } from "ai";
import { Readable } from "node:stream";
import { generateId } from "ai";
import type { Response } from "express";

import { createScopedLogger } from "../utils/logger";
import { getTachyonModel } from "../modules/llm/providers/tachyon";
import { streamText, type Messages, type StreamingOptions } from "./stream-text";
import type { FileMap } from "./constants";
import type { IProviderSetting } from "../types/model";
import type { DesignScheme } from "../types/design-scheme";
import type { ProgressAnnotation } from "../types/context";
import { buildIndex, saveIndex, search, searchWithGraph } from '../modules/ai_engine/agent'

export interface StreamWriter {
    writeData: (data: unknown) => boolean;
    writeAnnotation: (annotation: unknown) => boolean;
    isAlive: () => boolean;
}



// [ScratchPad disabled - token testing]
// import {
//   createScratchPad,
//   completeStep,
//   serializeScratchPad,
//   type ScratchPad,
// } from "./scratchpad";


// --- Frame-level constants -------------------------------------------------

/**
 * Regex patterns for the Vercel AI SDK Data Stream Protocol frames that we
 * must intercept / rewrite when stitching multiple LLM calls into one stream.
 * * Frame format: `<prefix>:<json>\n`
 * * Frames we SKIP entirely (emitted per-LLM-call by the SDK):
 * f: - messageId header  -> we emit ONE at the very start
 * e: - finish frame      -> we rewrite isContinued ourselves
 * d: - done frame        -> we emit ONE at the very end
 */
const FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;

/**
 * Strip accidental markdown code fences that wrap <cortexArtifact> blocks
 * from the COMPLETE accumulated text of one LLM phase.
 * * The LLM sometimes emits its artifact inside ```xml ... ``` even though the
 * system prompt forbids it. Because the fence tokens are spread across many
 * small `0:` delta chunks we cannot strip them per-chunk; we must operate on
 * the fully reassembled text.
 * * Patterns handled:
 * ```xml\n<cortexArtifact>...</cortexArtifact>\n```
 * ```\n<cortexArtifact>...</cortexArtifact>\n```
 * (leading prose before the fence is preserved)
 * 
 * 
 */
 function stripCodeFencesFromFullText(text: string): string {
  // Remove any opening code fence immediately before <cortexArtifact
  // The fence may be preceded by prose/whitespace on the same or previous line.
  text = text.replace(/```[a-z]*\r?\n(?=<cortexArtifact)/gi, "");
  // Remove any closing ``` that appears after </cortexArtifact>
  text = text.replace(/(?<=<\/cortexArtifact>)\r?\n```/gi, "");
  // Fallback: strip a lone opening fence at the very start of the text
  text = text.replace(/^```[a-z]*\r?\n/i, "");
  // Fallback: strip a lone closing fence at the very end of the text
  text = text.replace(/\r?\n```\s*$/i, "");
  return text;
}

// --- Console streaming helper ------------------------------------------

const logger = createScopedLogger("plan-processor");

/**
 * Stream a real-time console log line to the frontend via the `2:` data-stream
 * part. The frontend can render these in a terminal/console panel so the user
 * sees what is happening in the background as it happens.
 */

// --- Types -------------------------------------------------------------

export interface PlanStep {
  /** Step number (1-based) */
  index: number;
  /** Short heading for the step */
  heading: string;
  details: string;
}

export interface ParsedPlan {
  steps: PlanStep[];
  /** Raw markdown content of the PLAN.md */
  rawContent: string;
}

// --- Helpers -----------------------------------------------------------

/**
 * Locate PLAN.md (case-insensitive) anywhere in the files map and return its content.
 */
export function extractPlanContent(files: FileMap): string | null {
  for (const [path, entry] of Object.entries(files)) {
    const name = path.split("/").pop()?.toLowerCase();
    if (
      name === "plan.md" &&
      entry &&
      entry.type === "file" &&
      !entry.isBinary &&
      typeof entry.content === "string"
    ) {
      return entry.content;
    }
  }
  return null;
}

// --- LLM: Parse plan into steps ----------------------------------------
/**
 * Send the PLAN.md content to the LLM and ask it to return a structured list
 * of steps with a short heading and full details for each.
 * * The returned JSON is:
 * ```json
 * [
 * { "index": 1, "heading": "Project Setup", "details": "..." },
 * ...
 * ]
 * ```
 */
export async function parsePlanIntoSteps(
  planContent: string,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Parsing PLAN.md into steps via LLM...");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a project planning assistant. Your job is to read a project plan written in Markdown and break it down into clear, actionable implementation steps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise title for the step, ≤ 80 chars)
"details" : string  (full implementation guidance, tasks, and subtasks for that step)

Rules:
- Preserve all task details from the original plan.
- Group logically-related tasks into a single step (e.g. one phase = one step).
- Keep "heading" short and descriptive.
- "details" may be multi-line; use \\n for newlines inside the JSON string.
- Do NOT add steps that are not in the plan.
- Do NOT wrap output in markdown code fences.
`,
    prompt: `
Here is the project plan:

<plan>
${planContent}
</plan>

Return the structured JSON array of steps now.
`,
  });

  if (onFinish) onFinish(resp);

  try {
    // Strip any accidental markdown fences the model may add
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as PlanStep[];
    logger.info(`Parsed ${parsed.length} steps from PLAN.md`);
    return parsed;
  } catch (err: any) {
        logger.error("Failed to parse LLM step response as JSON, falling back to single step", err);
        // Graceful fallback: treat entire plan as one step
        return [
        {
            index: 1,
            heading: "Implement Plan",
            details: planContent,
        },
        ];
    
    }
}

// -----------
/**
 * Given a plain-language user request (no PLAN.md), ask the LLM to produce
 * structured implementation steps in the same format as `parsePlanIntoSteps`.
 * * Used in 'build' chat mode when `implementPlan` is false.
 */
export async function generateStepsFromQuestion(
  userQuestion: string,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Generating implementation steps from user question via LLM...");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a project planning assistant specializing in industry-level software development. Given a user's request, break it down into clear, actionable implementation steps, focusing on business logic, system architecture, and technical requirements.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise title for the step, ≤ 80 chars)
"details" : string  (full implementation guidance, tasks, and subtasks for that step)

Rules:
- Identify all work needed to fulfill the user's request, emphasizing business value and architectural considerations.
- Group logically-related tasks into a single step.
- Keep "heading" short and descriptive, reflecting the step's strategic importance.
- "details" may be multi-line; use \\n for newlines inside the JSON string to separate tasks within a step.
- Steps should be ordered logically (architecture and data modeling first, then business logic, UI, integrations, and finally, deployment and maintenance).
- Focus on generating steps that reflect industry best practices for scalability, security, and maintainability.
- For React projects, emphasize professional page design, component architecture, and full implementation of business functionalities within the UI. Consider user experience (UX) principles in UI-related steps.
- Where applicable, include considerations for data modeling, API design, security implications, performance optimization, and scalability within the step details.
- Do NOT wrap output in markdown code fences.
`,
    prompt: `
Here is the user's request:

<request>
${userQuestion}
</request>

Return the structured JSON array of implementation steps now. Focus on high-level design and business logic implementation.
`,
  });

  if (onFinish) onFinish(resp);

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as PlanStep[];
    logger.info(`Generated ${parsed.length} steps from user question`);
    return parsed;
  } catch (err: any) {
    logger.error("Failed to parse LLM step response as JSON, falling back to single step", err);
    return [
      {
        index: 1,
        heading: "Implement Request",
        details: userQuestion,
      },
    ];
  }
}

async function pipeStreamToResponse(
  requestId: string,
  res: Response,
  webStream: ReadableStream,
  stepNum: number,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping step ${stepNum}`);
    return;
  }

  const nodeStream = Readable.fromWeb(webStream as any);
  let nonTextFrames = 0;
  // Buffer for partial lines split across TCP chunks
  let lineBuffer = "";
  // Accumulate all 0: text deltas into one string for post-processing
  let fullText = "";

  function processLine(line: string): void {
    if (!line) return;

    const m = FRAME_RE.exec(line);
    if (m) {
      const prefix = m[1];
      const value = m[2];

      // Drop frames the caller manages globally:
      // f: = messageId header (we emit ONE shared header upfront)
      // e: = step finish      (we write the correct isContinued frame ourselves)
      // d: = stream done      (caller writes ONE at the very end)
      // g: = SDK step-start   (AI SDK v4 emits this before text; we manage our own
      //                        multi-step framing so this frame is noise here)
      if (prefix === "f" || prefix === "e" || prefix === "d" || prefix === "g") {
        logger.debug(`[${requestId}] Step ${stepNum} dropping frame: ${prefix}:...`);
        return;
      }

      // Capture LLM error frames - log but do NOT forward.
      // A 3: frame terminates the Vercel AI SDK frontend stream immediately.
      if (prefix === "3") {
        logger.warn(`[${requestId}] Step ${stepNum} LLM error frame received: ${value}`);
        return;
      }

      // Forward text deltas immediately for live streaming UX
      if (prefix === "0") {
        res.write(`${line}\n`);
        try {
          fullText += JSON.parse(value) as string;
        } catch {
          fullText += value;
        }
        return;
      }
    }

    // Forward everything else (1:, 2:, 8:, etc.) immediately
    res.write(`${line}\n`);
    nonTextFrames++;
  }

  nodeStream.on("data", (chunk: Buffer) => {
    const text = lineBuffer + chunk.toString("utf8");
    const lines = text.split("\n");
    // Last element may be an incomplete line - keep it in the buffer
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  });

  return new Promise<void>((resolve, reject) => {
    nodeStream.on("end", () => {
      // Flush any remaining partial line
      if (lineBuffer) processLine(lineBuffer);

      // Deltas were forwarded live - nothing to emit here.
      logger.info(
        `[${requestId}] Step ${stepNum} stream ended: textLen=${fullText.length}, nonTextFrames=${nonTextFrames}`
      );
      resolve();
    });

    nodeStream.on("error", (err: Error) => {
      logger.error(`[${requestId}] Step ${stepNum} stream error: ${err?.message || err}`, err);
      reject(err);
    });
  });
}

export interface StreamPlanOptions {
  res: Response;
  requestId: string;
  /** Original user messages */
  messages: Messages;
  /** All files from the request body */
  files: FileMap;
  /**
   * User's plain-language request.
   * Required when 'implementPlan' is false and chatMode is "build".
   * Not needed when PLAN.md is present in `files`.
   */
  userQuestion?: string;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  promptId: string;
  chatMode: "discuss" | "build";
  designScheme?: DesignScheme;
  progressCounter: { value: number };
  writer: StreamWriter;
  summary?: string;
  cumulativeUsage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
}

/**
 * Main entry-point called from `chatHandler` when `implementPlan === true`.
 * * Flow:
 * 1. Extract PLAN.md content from `files`.
 * 2. Call LLM to parse it into structured steps (heading + details).
 * 3. Stream each step one-by-one, just like batch-processor does for files.
 * 4. Write progress annotations between steps so the frontend stays informed.
 */
export async function streamPlanResponse(opts: StreamPlanOptions): Promise<void> {
  const {
    res,
    requestId,
    messages,
    files,
    userQuestion,
    streamingOptions,
    apiKeys,
    providerSettings,
    promptId,
    chatMode,
    designScheme,
    summary,
    progressCounter,
    writer,
    cumulativeUsage,
  } = opts;

    // -- 1. Resolve plan content: PLAN.md (implementPlan) or user question (build mode) ---
    const planContent = extractPlanContent(files);
    const usePlanMd = !!planContent;

    if (!usePlanMd && !userQuestion?.trim()) {
        logger.warn(`[${requestId}] No PLAN.md found and no user question provided — skipping plan execution`);
        writer.writeData({
        type: "progress",
        label: "plan",
        status: "complete",
        order: progressCounter.value++,
        message: "⚠️ No PLAN.md and no user question — skipping plan execution",
        } satisfies ProgressAnnotation);
        return;
    }

    if (usePlanMd) {
        logger.info(`[${requestId}] PLAN.md found (${planContent!.length} chars), parsing into steps...`);
    } else {
        logger.info(`[${requestId}] No PLAN.md — generating plan from user question: "${userQuestion!.substring(0, 100)}..."`);
    }

    writer.writeData({
        type: "progress",
        label: "plan-parse",
        status: "in-progress",
        order: opts.progressCounter.value++,
        message: usePlanMd ? "Reading implementation plan..." : "Generating implementation plan...",
    } satisfies ProgressAnnotation);

  // -- 2. Parse / generate plan steps via LLM -----------------------------------------

    const onUsage = (resp: any) => {
        if (resp?.usage) {
        opts.cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
        opts.cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
        opts.cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
        }
    };

    let steps: PlanStep[];
    try {
        steps = usePlanMd
            ? await parsePlanIntoSteps(planContent!, onUsage)
            : await generateStepsFromQuestion(userQuestion!, onUsage);
    } catch (err: any) {
        logger.error(`[${requestId}] Step generation failed: ${err?.message}`, err);
        writer.writeData({
            type: "progress",
            label: "plan-parse",
            status: "complete",
            order: progressCounter.value++,
            message: `⚠️ Failed to generate plan: ${err?.message}`,
        } satisfies ProgressAnnotation);
        return;
    }

    writer.writeData({
        type: "progress",
        label: "plan-parse",
        status: "complete",
        order: progressCounter.value++,
        message: `✅ Plan parsed into ${steps.length} step${steps.length !== 1 ? "s" : ""}`,
    } satisfies ProgressAnnotation);

    // Emit the plan structure as a message annotation so the UI can display it
    writer.writeAnnotation({
        type: "planSteps",
        steps: steps.map((s) => ({ index: s.index, heading: s.heading })),
        totalSteps: steps.length,
    });


    // — 3. Emit ONE shared messageId header ———————————————————
    // All phases share a single f: frame so the frontend treats the entire
    // multi-phase output as one continuous message stream.
    const sharedMessageId = generateId();
    res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);
    logger.info(`[${requestId}] Emitted shared messageId: ${sharedMessageId}`);

    // — 4. Execute each step ——————————————————————————————————
    // [ScratchPad disabled] const goal = ...
    // [ScratchPad disabled] let pad: ScratchPad = createScratchPad(goal, steps);
    // [ScratchPad disabled] logger/writeConsole for ScratchPad init
    let succeededSteps = 0;
    let failedSteps = 0;

    for (const step of steps) {
        if (!writer.isAlive()) {
            logger.warn(`[${requestId}] Client disconnected before step ${step.index}, aborting plan`);
            return;
        }

        logger.info(`[${requestId}] Plan step ${step.index}/${steps.length}: "${step.heading}"`);

        // Progress: step starting
        writer.writeData({
            type: "progress",
            label: `plan-step${step.index}`,
            status: "in-progress",
            order: progressCounter.value++,
            message: `🛰️ Step ${step.index}/${steps.length}: ${step.heading}`,
        } satisfies ProgressAnnotation);

        // — Build messages for this step ——————————————————————
        const stepMessages: Messages = [...messages];

        // Build a concise list of all steps so the model understands the full scope
        const allStepsList = steps
            .map((s) => `  ${s.index}. ${s.heading}${s.index === step.index ? " <- CURRENT" : s.index < step.index ? " ✅ done" : ""}`)
            .join("\n");

        // Remaining steps after current one (so model knows what NOT to implement yet)
        const remainingSteps = steps
            .filter((s) => s.index > step.index)
            .map((s) => `  ${s.index}. ${s.heading}`)
            .join("\n");

        // [ScratchPad disabled] const scratchPadText = serializeScratchPad(pad);
        // [ScratchPad disabled] logger/writeConsole for ScratchPad injected

        if (step.index > 1) {
            // Steps 2+: brief assistant turn to maintain conversation continuity.
            const prevStep = steps[step.index - 2];

            stepMessages.push({
                id: generateId(),
                role: "assistant",
                content: `Step ${prevStep.index}/${steps.length} complete ✅ ${prevStep.heading}.`,
            } as any);

            stepMessages.push({
                id: generateId(),
                role: "user",
                content: [
                    `## Plan Progress`,
                    allStepsList,
                    ``,
                    `## Your Task - Step ${step.index}/${steps.length}: ${step.heading}`,
                    ``,
                    step.details,
                    ``,
                    remainingSteps
                        ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
                        : `## This is the FINAL step - complete the implementation.`,
                    ``,
                    `Generate ONLY the file changes required for Step ${step.index}. No shell commands. No npm installs.`,
                ].join("\n"),
            } as any);
        } else {
            // First step: prime the model with full context.
            const planContext = usePlanMd
                ? [`## Full Plan Details (for reference only)`, planContent!, ``]
                : [`## User Request`, userQuestion!, ``];

            stepMessages.push({
                id: generateId(),
                role: "user",
                content: [
                    `You are implementing a project plan step by step. There are ${steps.length} steps in total.`,
                    ``,
                    ...planContext,
                    `## Full Plan Overview`,
                    allStepsList,
                    ``,
                    `---`,
                    ``,
                    `## Your Task - Step ${step.index}/${steps.length}: ${step.heading}`,
                    ``,
                    step.details,
                    ``,
                    remainingSteps
                        ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
                        : `## This is the ONLY step - complete the full implementation.`,
                    ``,
                    `Generate ONLY the file changes required for Step ${step.index}. No shell commands. No npm installs.`,
                ].join("\n"),
            } as any);
        }

        // — Stream this step ——————————————————————————————————
        // Pass all files but disable contextOptimization so stream-text does NOT
        // auto-inject a context buffer into the system prompt. The per-step user
        // message already carries exactly the right instructions and file scope.
        // Keyword-based file filtering was removed because generic plan headings
        // (e.g. "Phase 1: ...", "Phase 2: ...") produce overlapping keywords that
        // cause every step to receive the same files and regenerate the same content.
        const stepStreamOptions: StreamingOptions = {
            ...streamingOptions,
        };

        let filesToUse: FileMap = files;
        try {
            const query = `${step.heading} ${step.details}`;
           
            const relevantPaths: string[] = searchWithGraph(query, 5, 1);
            if (relevantPaths.length > 0) {
                const stepFiles: FileMap = {};
                for (const relPath of relevantPaths) {
                    const fullPath = `/home/project/${relPath}`;
                    if (Object.prototype.hasOwnProperty.call(files, fullPath)) {
                        stepFiles[fullPath] = files[fullPath];
                    }
                }

                if (Object.keys(stepFiles).length > 0) {
                    filesToUse = stepFiles;
                    const shortPaths = Object.keys(stepFiles).map((p) => p.replace("/home/project/", ""));
                    
                } 
            } else {
                //writeConsole(writer, "warn", "📂 Index returned no results - using full file set");
            }
        } catch {
            //writeConsole(writer, "warn", "📂 File index not available - using full file set");
        }

        logger.info(
            `[${requestId}] Step ${step.index}/${steps.length} streaming with ${Object.keys(filesToUse).length}/${Object.keys(files).length} files`,
        );
        

        try {
            const result = await streamText({
                messages: stepMessages,
                env: undefined as any,
                options: stepStreamOptions,
                apiKeys,
                files: filesToUse,
                providerSettings,
                promptId: "plan", // always use plan prompt - no shell commands between steps
                chatMode,
                designScheme,
                summary,
                contextOptimization: false, // disable auto context buffer injection per step
                // No messagesSliceId - we build our own message array per step
                messageSliceId: undefined,
            });

            // Pipe the stream to the response AND await the full text promise in parallel.
            // result.text is a Promise<string> resolved by the AI SDK once the stream is
            // fully consumed - awaiting it here guarantees stepText is populated before we
            // build the summary and move to the next iteration.
            //
            // pipeStreamToResponse drops the per-phase f:/e:/d: frames emitted by the SDK.
            // After piping we write the correct e: frame ourselves:
            //   • isContinued:true  -> keeps the frontend stream alive (phases 1 .. N-1)
            //   • isContinued:false -> signals end of stream (final phase only)
            // The d: "done" frame is written only once, after the final phase.
            const response = result.toDataStreamResponse();

            const [stepText] = await Promise.all([
                result.text,
                response.body ? pipeStreamToResponse(requestId, res, response.body, step.index) : Promise.resolve(),
            ]);

            // Guard: bail immediately if client disconnected during this step's stream —
            // pipeStreamToResponse reads from the LLM (not from the client), so it runs to
            // completion even after the client drops. We must check here before writing any
            // more frames to avoid spurious writes to a destroyed socket.
            if (!writer.isAlive()) {
                logger.warn(`[${requestId}] Client disconnected during step ${step.index} streaming, aborting plan`);
                return;
            }

            // Accumulate token usage from the resolved usage promise
            const usage = await result.usage;
            if (usage) {
                cumulativeUsage.completionTokens += usage.completionTokens || 0;
                cumulativeUsage.promptTokens += usage.promptTokens || 0;
                cumulativeUsage.totalTokens += usage.totalTokens || 0;
            }

            logger.info(
                `[${requestId}] Step ${step.index} finished: tokens=${usage?.totalTokens || 0}`,
            );

            if (!stepText && !(usage?.totalTokens)) {
                logger.warn(`[${requestId}] Step ${step.index} returned empty response (0 text, 0 tokens) - LLM may have produced no output`);
            }

            // Write the e: finish frame with the correct isContinued flag.
            // isContinued:true  -> keeps the frontend parser alive between steps
            // isContinued:false -> tells the frontend this is the last step
            // NOTE: the d: "done" frame is intentionally NOT written here.
            // It must be the very last frame before res.end(), so it is written
            // by the caller (chat.ts) after all post-step annotations are flushed.
            if (!res.writableEnded && !res.destroyed) {
                const eFrame = {
                    finishReason: "stop",
                    usage: {
                        promptTokens: usage?.promptTokens ?? 0,
                        completionTokens: usage?.completionTokens ?? 0,
                    },
                };
                res.write(`e:${JSON.stringify(eFrame)}\n`);
            } else {
                logger.warn(`[${requestId}] Step ${step.index}: skipping e: frame - response already ended`);
            }

            // [ScratchPad disabled] pad = completeStep(pad, step, stepText, true);
            succeededSteps++;
           
            // [ScratchPad disabled] writeConsole ScratchPad updated
            // [ScratchPad disabled] writer.writeAnnotation scratchpad
        } catch (err: any) {
            logger.error(`[${requestId}] Step ${step.index} error: ${err?.message}`, err);

            writer.writeData({
                type: "progress",
                label: "plan-step-error",
                status: "complete",
                order: progressCounter.value++,
                message: `⚠️ Step ${step.index} failed: ${err?.message || "Unknown error"}. Continuing...`,
            } satisfies ProgressAnnotation);

            // [ScratchPad disabled] pad = completeStep failure tracking
            failedSteps++;
            
            continue;
        }

        // Progress: step complete
        writer.writeData({
            type: "progress",
            label: `plan-step${step.index}`,
            status: "complete",
            order: progressCounter.value++,
            message: `✅ Step ${step.index}/${steps.length} complete: ${step.heading}`,
        } satisfies ProgressAnnotation);
    }

    // — 4. All steps done —————————————————————————————————————
    logger.info(`[${requestId}] All ${steps.length} plan steps complete. Total tokens: ${cumulativeUsage.totalTokens}`);

    // [ScratchPad disabled] const failedCount / succeededCount from pad.completedSteps
    // [ScratchPad disabled] pad.modifiedFiles summary
    

    writer.writeData({
        type: "progress",
        label: "plan-complete",
        status: "complete",
        order: progressCounter.value++,
        message: `🎉 Implementation plan complete 🏁 all ${steps.length} step${steps.length !== 1 ? "s" : ""} executed`,
    } satisfies ProgressAnnotation);
}