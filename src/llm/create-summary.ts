import { generateText, type CoreTool, type GenerateTextResult, type Message } from "ai";

import { createScopedLogger } from "../utils/logger";
import { extractCurrentContext, simplifyCortexActions } from "./utils";
import { getTachyonModel } from "../modules/llm/providers/tachyon";

const logger = createScopedLogger("create-summary");

export async function createSummary(props: {
  messages: Message[];
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, onFinish } = props;

  // Clean assistant messages (remove cortex thoughts)
  const processedMessages = messages.map((message) => {
    if (message.role === "assistant") {
      let content = message.content as any;

      if (typeof content === "string") {
        content = simplifyCortexActions(content);
        content = content.replace(/<div class=\\"__cortexThought__\\">.*?<\/div>/s, "");
        content = content.replace(/<think>.*?<\/think>/s, "");
      }

      return { ...message, content };
    }

    return message;
  });

  let slicedMessages = processedMessages;
  const { summary } = extractCurrentContext(processedMessages);

  let summaryText: string | undefined;
  let chatId: string | undefined;

  if (summary && summary.type === "chatSummary") {
    chatId = summary.chatId;
    summaryText = `
Below is the Chat Summary till now, this is chat summary before the conversation provided by the user.
Use this as historical context.

${summary.summary}
`;

    if (chatId) {
      const index = processedMessages.findIndex((m: any) => m.id === chatId);
      if (index >= 0) slicedMessages = processedMessages.slice(index + 1);
    }
  }

  logger.debug("Sliced Messages:", slicedMessages.length);

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? ((message.content as any[]).find((item) => item.type === "text")?.text as string) || ""
      : (message.content as any);

  const resp = await generateText({
    model: getTachyonModel(),

    system: `
You are a software engineer. You are working on a project. you need to summarize the work till now and provide a summary of the chat till now.

Please only use the following format to generate the summary:
---
# Project Overview
- **Project**: {project_name} - {brief_description}
- **Current Phase**: {phase}
- **Tech Stack**: {languages}, {frameworks}, {key_dependencies}
- **Environment**: {critical_env_details}

# Conversation Context
- **Last Topic**: {main_discussion_point}
- **Key Decisions**: {important_decisions_made}
- **User Context**:
  - Technical Level: {expertise_level}
  - Preferences: {coding_style_preferences}
  - Communication: {preferred_explanation_style}

# Implementation Status
## Current State
- **Active Feature**: {feature_in_development}
- **Progress**: {what_works_and_what_doesn't}
- **Blockers**: {current_challenges}

## Code Evolution
- **Recent Changes**: {latest_modifications}
- **Working Patterns**: {successful_approaches}
- **Failed Approaches**: {attempted_solutions_that_failed}

# Requirements
- **Implemented**: {completed_features}
- **In Progress**: {current_focus}
- **Pending**: {upcoming_features}
- **Technical Constraints**: {critical_constraints}

# Critical Memory
- **Must Preserve**: {crucial_technical_context}
- **User Requirements**: {specific_user_needs}
- **Known Issues**: {documented_problems}

# Next Actions
- **Immediate**: {next_steps}
- **Open Questions**: {unresolved_issues}
---

RULES:
* Only provide the summary.
* Do not invent new info.
* Use provided structure exactly.
    `,

    prompt: `
Here is the previous summary of the chat:
<old_summary>
${summaryText || ""}
</old_summary>

Below is the chat after that:
---
<new_chats>
${slicedMessages
  .map((x) => `---\n[${(x as any).role}] ${extractTextContent(x as any)}\n---`)
  .join("\n")}
</new_chats>
---

Please provide a summary of the chat till now including the historical summary.
`,
  });

  if (onFinish) onFinish(resp);

  return resp.text;
}