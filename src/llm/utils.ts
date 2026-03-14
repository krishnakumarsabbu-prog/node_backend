import { type Message } from 'ai';
import { DEFAULT_MODEL, MODEL_REGEX, PROVIDER_REGEX, WORK_DIR } from '../utils/constants';
import { IGNORE_PATTERNS, type FileMap } from './constants';
import ignore from 'ignore';
import { ContextAnnotation } from '../types/context';

const _ig = ignore().add(IGNORE_PATTERNS);

export function extractPropertiesFromMessage(message: Omit<Message, 'id'>): {
  model: string;
  provider: string;
  content: string;
} {
  const textContent = Array.isArray(message.content)
    ? message.content.find((item) => item.type === 'text')?.text || ''
    : message.content;

  const modelMatch = textContent.match(MODEL_REGEX);
  const providerMatch = textContent.match(PROVIDER_REGEX);

  /*
   * Extract model
   * const modelMatch = message.content.match(MODEL_REGEX);
   */
  const model = modelMatch ? modelMatch[1] : DEFAULT_MODEL;

  /*
   * Extract provider
   * const providerMatch = message.content.match(PROVIDER_REGEX);
   */
  const provider = providerMatch ? providerMatch[1] : 'tachyon';

  const cleanedContent = Array.isArray(message.content)
    ? message.content.map((item) => {
        if (item.type === 'text') {
          return {
            type: 'text',
            text: item.text?.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, ''),
          };
        }

        return item; // Preserve image_url and other types as is
      })
    : textContent.replace(MODEL_REGEX, '').replace(PROVIDER_REGEX, '');

  return { model, provider, content: cleanedContent };
}

export function simplifyCortexActions(input: string): string {
  // Using regex to match cortexAction tags that have type="file"
  const regex = /(<cortexAction[^>]*type="file"[^>]*>)([\s\S]*?)(<\/cortexAction>)/g;

  // Replace each matching occurrence
  return input.replace(regex, (_0, openingTag, _2, closingTag) => {
    return `${openingTag}\n          ...\n        ${closingTag}`;
  });
}

function isSafeFilePath(filePath: string): boolean {
  if (filePath.includes('..')) return false;
  const dangerousPrefixes = ['/etc/', '/root/', '/proc/', '/sys/', '/dev/', '/boot/'];
  for (const prefix of dangerousPrefixes) {
    if (filePath.startsWith(prefix)) return false;
  }
  return true;
}

export function createFilesContext(files: FileMap, useRelativePath?: boolean) {
  let filePaths = Object.keys(files);
  filePaths = filePaths.filter((x) => {
    if (!isSafeFilePath(x)) return false;
    const relPath = x.replace(`${WORK_DIR}/`, '');
    return !_ig.ignores(relPath);
  });

  const fileContexts = filePaths
    .filter((x) => files[x] && files[x].type === 'file' && !(files[x] as any).isBinary)
    .map((path) => {
      const dirent = files[path];

      if (!dirent || dirent.type === 'folder') {
        return '';
      }

      const codeWithLinesNumbers = dirent.content.split('\n').join('\n');

      const filePath = useRelativePath ? path.replace(`${WORK_DIR}/`, '') : path;

      return `<cortexAction type="file" filePath="${filePath}">${codeWithLinesNumbers}</cortexAction>`;
    });

  return `<cortexArtifact id="code-content" title="Code Content" >\n${fileContexts.join('\n')}\n</cortexArtifact>`;
}

export function extractCurrentContext(messages: Message[]) {
  let summary: ContextAnnotation | undefined;
  let codeContext: ContextAnnotation | undefined;

  const assistantMessages = messages.filter((x) => x.role === 'assistant');

  for (let mi = assistantMessages.length - 1; mi >= 0; mi--) {
    const msg = assistantMessages[mi];
    if (!msg.annotations?.length) continue;

    for (const annotation of msg.annotations) {
      if (!annotation || typeof annotation !== 'object') continue;
      const ann = annotation as any;
      if (!ann.type) continue;

      if (!codeContext && ann.type === 'codeContext') codeContext = ann;
      if (!summary && ann.type === 'chatSummary') summary = ann;
    }

    if (summary && codeContext) break;
  }

  return { summary, codeContext };
}
