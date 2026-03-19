import type { FileMap } from "../../llm/constants";

export type FileRole = "controller" | "service" | "repository" | "config" | "model" | "entry" | "test" | "other";

export interface MethodSummary {
  name: string;
  annotations: string[];
  returnType: string;
  params: string[];
}

export interface InjectedField {
  name: string;
  type: string;
  injectionStyle: "field" | "constructor" | "setter";
}

export interface FileSummary {
  path: string;
  role: FileRole;
  language: string;
  annotations: string[];
  imports: string[];
  classNames: string[];
  methods: MethodSummary[];
  injectedFields: InjectedField[];
  usesXmlConfig: boolean;
  usesAutowired: boolean;
  usesFieldInjection: boolean;
  usesConstructorInjection: boolean;
  usesComponentScan: boolean;
  usesTransactional: boolean;
  isSpringBootMain: boolean;
  hasDispatcherServletRef: boolean;
  lineCount: number;
}

const JAVA_ANNOTATION_RE = /@(\w+)(?:\([^)]*\))?/g;
const JAVA_IMPORT_RE = /^import\s+([\w.]+(?:\.\*)?);/gm;
const JAVA_CLASS_RE = /(?:public|protected|private)?\s*(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/g;
const JAVA_METHOD_RE = /(?:@\w+(?:\([^)]*\))\s*)*\s*(?:public|protected|private|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;

const TS_IMPORT_RE = /^import\s+.*?from\s+['"]([^'"]+)['"]/gm;
const TS_CLASS_RE = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
const TS_DECORATOR_RE = /@(\w+)(?:\([^)]*\))?/g;
const TS_METHOD_RE = /(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[\w<>\[\],\s|?]+)?\s*\{/g;

function extractInjectedFields(lines: string[]): InjectedField[] {
  const fields: InjectedField[] = [];
  let pendingAnnotations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const annMatch = line.match(/^@(\w+)/);
    if (annMatch) {
      pendingAnnotations.push(annMatch[1]);
      continue;
    }

    if (pendingAnnotations.includes("Autowired") || pendingAnnotations.includes("Inject") || pendingAnnotations.includes("Resource")) {
      const fieldMatch = line.match(/^(?:private|protected|public)\s+([\w<>[\],\s]+?)\s+(\w+)\s*;/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[2], type: fieldMatch[1].trim(), injectionStyle: "field" });
        pendingAnnotations = [];
        continue;
      }
      const constructorMatch = line.match(/^(?:public|protected)\s+\w+\s*\(/);
      if (constructorMatch) {
        fields.push({ name: "constructor", type: "multiple", injectionStyle: "constructor" });
        pendingAnnotations = [];
        continue;
      }
      const setterMatch = line.match(/^(?:public|protected)\s+void\s+set(\w+)\s*\(/);
      if (setterMatch) {
        fields.push({ name: setterMatch[1].charAt(0).toLowerCase() + setterMatch[1].slice(1), type: "unknown", injectionStyle: "setter" });
        pendingAnnotations = [];
        continue;
      }
    }

    if (line.length > 0 && !line.startsWith("//") && !line.startsWith("*")) {
      pendingAnnotations = [];
    }
  }

  return fields;
}

function extractJavaFileSummary(path: string, content: string): FileSummary {
  const annotations: string[] = [];
  const imports: string[] = [];
  const classNames: string[] = [];
  const methods: MethodSummary[] = [];

  let m: RegExpExecArray | null;

  JAVA_ANNOTATION_RE.lastIndex = 0;
  while ((m = JAVA_ANNOTATION_RE.exec(content)) !== null) {
    if (!annotations.includes(m[1])) annotations.push(m[1]);
  }

  JAVA_IMPORT_RE.lastIndex = 0;
  while ((m = JAVA_IMPORT_RE.exec(content)) !== null) {
    imports.push(m[1]);
  }

  JAVA_CLASS_RE.lastIndex = 0;
  while ((m = JAVA_CLASS_RE.exec(content)) !== null) {
    classNames.push(m[1]);
  }

  const lines = content.split("\n");
  const methodAnnotations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const annMatch = line.match(/^@(\w+)/);
    if (annMatch) {
      methodAnnotations.push(annMatch[1]);
      continue;
    }
    const methMatch = line.match(/(?:public|protected|private|static|final|\s)+([\w<>\[\],\s]+)\s+(\w+)\s*\(([^)]*)\)/);
    if (methMatch && !line.startsWith("class ") && !line.startsWith("interface ")) {
      const returnType = methMatch[1].trim().split(/\s+/).pop() || "void";
      const name = methMatch[2];
      const params = methMatch[3].split(",").map((p) => p.trim()).filter(Boolean);
      if (name && name !== "if" && name !== "for" && name !== "while") {
        methods.push({ name, annotations: [...methodAnnotations], returnType, params });
      }
      methodAnnotations.length = 0;
    } else if (!line.startsWith("@") && line.length > 0 && !line.startsWith("//")) {
      methodAnnotations.length = 0;
    }
  }

  const injectedFields = extractInjectedFields(lines);
  const usesFieldInjection = injectedFields.some((f) => f.injectionStyle === "field");
  const usesConstructorInjection = injectedFields.some((f) => f.injectionStyle === "constructor");
  const role = detectJavaRole(path, annotations);
  const isSpringBootMain = annotations.includes("SpringBootApplication") || content.includes("@SpringBootApplication");
  const hasDispatcherServletRef = content.includes("DispatcherServlet") || content.includes("dispatcher-servlet");

  return {
    path,
    role,
    language: "java",
    annotations,
    imports,
    classNames,
    methods: methods.slice(0, 20),
    injectedFields,
    usesXmlConfig: content.includes(".xml") && (content.includes("ClassPathXmlApplicationContext") || content.includes("XmlWebApplicationContext")),
    usesAutowired: annotations.includes("Autowired") || content.includes("@Autowired"),
    usesFieldInjection,
    usesConstructorInjection,
    usesComponentScan: annotations.includes("ComponentScan") || content.includes("@ComponentScan"),
    usesTransactional: annotations.includes("Transactional") || content.includes("@Transactional"),
    isSpringBootMain,
    hasDispatcherServletRef,
    lineCount: lines.length,
  };
}

function detectJavaRole(path: string, annotations: string[]): FileRole {
  if (annotations.includes("Controller") || annotations.includes("RestController") || path.includes("Controller")) return "controller";
  if (annotations.includes("Service") || path.includes("Service")) return "service";
  if (annotations.includes("Repository") || path.includes("Repository") || path.includes("Dao")) return "repository";
  if (annotations.includes("Configuration") || annotations.includes("SpringBootApplication") || path.includes("Config")) return "config";
  if (path.toLowerCase().includes("test")) return "test";
  if (path.includes("Application") || path.includes("Main")) return "entry";
  if (path.includes("Entity") || path.includes("Model") || path.includes("Dto") || path.includes("domain")) return "model";
  return "other";
}

function extractTsFileSummary(path: string, content: string): FileSummary {
  const annotations: string[] = [];
  const imports: string[] = [];
  const classNames: string[] = [];
  const methods: MethodSummary[] = [];

  let m: RegExpExecArray | null;

  TS_IMPORT_RE.lastIndex = 0;
  while ((m = TS_IMPORT_RE.exec(content)) !== null) {
    imports.push(m[1]);
  }

  TS_CLASS_RE.lastIndex = 0;
  while ((m = TS_CLASS_RE.exec(content)) !== null) {
    classNames.push(m[1]);
  }

  TS_DECORATOR_RE.lastIndex = 0;
  while ((m = TS_DECORATOR_RE.exec(content)) !== null) {
    if (!annotations.includes(m[1])) annotations.push(m[1]);
  }

  TS_METHOD_RE.lastIndex = 0;
  const lines = content.split("\n");
  const seenNames = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const methMatch = trimmed.match(/^(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(\w+)\s*\(([^)]*)\)/);
    if (methMatch && !seenNames.has(methMatch[1]) && methMatch[1] !== "if" && methMatch[1] !== "for" && methMatch[1] !== "while" && methMatch[1] !== "function") {
      seenNames.add(methMatch[1]);
      const params = methMatch[2].split(",").map((p) => p.trim().split(":")[0].trim()).filter(Boolean);
      methods.push({ name: methMatch[1], annotations: [], returnType: "unknown", params });
    }
  }

  const role = detectTsRole(path, annotations, imports);

  return {
    path,
    role,
    language: path.endsWith(".tsx") || path.endsWith(".jsx") ? "tsx" : "typescript",
    annotations,
    imports,
    classNames,
    methods: methods.slice(0, 20),
    injectedFields: [],
    usesXmlConfig: false,
    usesAutowired: annotations.includes("Inject") || annotations.includes("Injectable"),
    usesFieldInjection: false,
    usesConstructorInjection: false,
    usesComponentScan: false,
    usesTransactional: annotations.includes("Transaction") || content.includes("transaction"),
    isSpringBootMain: false,
    hasDispatcherServletRef: false,
    lineCount: lines.length,
  };
}

function detectTsRole(path: string, annotations: string[], imports: string[]): FileRole {
  if (annotations.includes("Controller") || path.includes("controller")) return "controller";
  if (annotations.includes("Injectable") || path.includes("service") || path.includes("Service")) return "service";
  if (path.includes("repositor") || path.includes("Repository")) return "repository";
  if (annotations.includes("Module") || path.includes("config") || path.includes("Config")) return "config";
  if (path.includes(".spec.") || path.includes(".test.") || path.includes("/test/")) return "test";
  if (path.includes("main") || path.includes("index") || path.includes("server") || path.includes("app")) return "entry";
  if (path.includes("model") || path.includes("entity") || path.includes("dto") || path.includes("schema")) return "model";
  return "other";
}

function detectLanguage(path: string): string {
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".cs")) return "csharp";
  if (path.endsWith(".rb")) return "ruby";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".rs")) return "rust";
  return "other";
}

export function extractFileSummaries(files: FileMap): FileSummary[] {
  const summaries: FileSummary[] = [];

  for (const [path, entry] of Object.entries(files)) {
    if (!entry || entry.type !== "file" || entry.isBinary) continue;
    const content = (entry as any).content as string;
    if (!content || typeof content !== "string") continue;

    const lang = detectLanguage(path);

    if (lang === "java") {
      summaries.push(extractJavaFileSummary(path, content));
    } else if (lang === "typescript" || lang === "javascript") {
      summaries.push(extractTsFileSummary(path, content));
    } else {
      summaries.push({
        path,
        role: "other",
        language: lang,
        annotations: [],
        imports: [],
        classNames: [],
        methods: [],
        injectedFields: [],
        usesXmlConfig: false,
        usesAutowired: false,
        usesFieldInjection: false,
        usesConstructorInjection: false,
        usesComponentScan: false,
        usesTransactional: false,
        isSpringBootMain: false,
        hasDispatcherServletRef: false,
        lineCount: content.split("\n").length,
      });
    }
  }

  return summaries;
}

export function serializeFileSummary(s: FileSummary): string {
  const parts: string[] = [`[${s.role.toUpperCase()}] ${s.path} (${s.language}, ${s.lineCount} lines)`];

  if (s.classNames.length > 0) parts.push(`  Classes: ${s.classNames.join(", ")}`);
  if (s.annotations.length > 0) parts.push(`  Annotations: @${s.annotations.join(", @")}`);
  if (s.methods.length > 0) {
    const methStr = s.methods.slice(0, 8).map((m) => {
      const ann = m.annotations.length > 0 ? `@${m.annotations.join(" @")} ` : "";
      return `${ann}${m.returnType} ${m.name}(${m.params.join(", ")})`;
    }).join("; ");
    parts.push(`  Methods: ${methStr}`);
  }

  if (s.injectedFields.length > 0) {
    const fieldStr = s.injectedFields.slice(0, 5).map((f) => `${f.type} ${f.name}[${f.injectionStyle}]`).join(", ");
    parts.push(`  Injected: ${fieldStr}`);
  }

  const flags: string[] = [];
  if (s.usesFieldInjection) flags.push("field-injection");
  if (s.usesConstructorInjection) flags.push("constructor-injection");
  if (s.usesComponentScan) flags.push("@ComponentScan");
  if (s.usesTransactional) flags.push("@Transactional");
  if (s.usesXmlConfig) flags.push("XML-context");
  if (s.isSpringBootMain) flags.push("SpringBoot-main");
  if (s.hasDispatcherServletRef) flags.push("DispatcherServlet-ref");
  if (flags.length > 0) parts.push(`  Flags: ${flags.join(", ")}`);

  return parts.join("\n");
}
