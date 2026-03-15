import fs from "fs";
import path from "path";
import { createScopedLogger } from "../utils/logger.js";

const logger = createScopedLogger("disk-template-loader");

export interface DiskTemplate {
  id: string;
  label: string;
  description: string;
  files: Record<string, string>;
  installCommand: string;
  startCommand: string;
  fromDisk: true;
}

const META_FILE = "cortex-template.json";

interface TemplateMeta {
  label?: string;
  description?: string;
  installCommand?: string;
  startCommand?: string;
  ignore?: string[];
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz",
  ".mp4", ".mp3", ".wav",
  ".exe", ".dll", ".so", ".dylib",
]);

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function readFilesRecursive(
  dir: string,
  baseDir: string,
  ignore: Set<string>
): Record<string, string> {
  const files: Record<string, string> = {};

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (ignore.has(entry.name) || ignore.has(relativePath)) continue;
    if (entry.name === META_FILE) continue;
    if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".env.example") continue;

    if (entry.isDirectory()) {
      const sub = readFilesRecursive(fullPath, baseDir, ignore);
      Object.assign(files, sub);
    } else if (entry.isFile()) {
      if (isBinary(entry.name)) continue;
      try {
        files[relativePath] = fs.readFileSync(fullPath, "utf-8");
      } catch {
        logger.warn(`Could not read file: ${fullPath}`);
      }
    }
  }

  return files;
}

function loadSingleTemplate(templateDir: string): DiskTemplate | null {
  const id = path.basename(templateDir);

  let meta: TemplateMeta = {};
  const metaPath = path.join(templateDir, META_FILE);
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TemplateMeta;
    } catch {
      logger.warn(`Invalid JSON in ${metaPath}, using defaults`);
    }
  }

  const ignore = new Set<string>([
    "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
    ...(meta.ignore ?? []),
  ]);

  const files = readFilesRecursive(templateDir, templateDir, ignore);

  if (Object.keys(files).length === 0) {
    logger.warn(`Template "${id}" has no readable files, skipping`);
    return null;
  }

  const installCmd = meta.installCommand ?? inferInstallCommand(files);
  const startCmd = meta.startCommand ?? inferStartCommand(files, id);
  const label = meta.label ?? toLabel(id);
  const description = meta.description ?? `${label} template`;

  logger.info(`Loaded disk template: "${id}" (${Object.keys(files).length} files)`);

  return {
    id,
    label,
    description,
    files,
    installCommand: installCmd,
    startCommand: startCmd,
    fromDisk: true,
  };
}

function inferInstallCommand(files: Record<string, string>): string {
  if ("package.json" in files) return "npm install";
  if ("pom.xml" in files) return "mvn install -DskipTests";
  if (Object.keys(files).some((f) => f.endsWith(".csproj"))) return "dotnet restore";
  if ("build.gradle" in files || "build.gradle.kts" in files) return "./gradlew build -x test";
  if ("Cargo.toml" in files) return "cargo build";
  if ("go.mod" in files) return "go mod download";
  if ("requirements.txt" in files) return "pip install -r requirements.txt";
  return "";
}

function inferStartCommand(files: Record<string, string>, id: string): string {
  if ("package.json" in files) {
    try {
      const pkg = JSON.parse(files["package.json"]) as { scripts?: Record<string, string> };
      if (pkg.scripts?.dev) return "npm run dev";
      if (pkg.scripts?.start) return "npm start";
    } catch { /* noop */ }
  }
  if (Object.keys(files).some((f) => f.endsWith(".csproj"))) return "dotnet run";
  if ("pom.xml" in files) return "mvn spring-boot:run";
  if ("build.gradle" in files || "build.gradle.kts" in files) return "./gradlew bootRun";
  if ("Cargo.toml" in files) return "cargo run";
  if ("go.mod" in files) return "go run .";
  if ("requirements.txt" in files || id.includes("python") || id.includes("django") || id.includes("flask")) return "python main.py";
  return "";
}

function toLabel(id: string): string {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

let _cache: Map<string, DiskTemplate> | null = null;
let _cacheDir: string | null = null;

export function loadDiskTemplates(templatesDir: string): Map<string, DiskTemplate> {
  if (_cache && _cacheDir === templatesDir) return _cache;

  const result = new Map<string, DiskTemplate>();

  if (!fs.existsSync(templatesDir)) {
    logger.warn(`TEMPLATES_DIR "${templatesDir}" does not exist, no disk templates loaded`);
    _cache = result;
    _cacheDir = templatesDir;
    return result;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(templatesDir, { withFileTypes: true });
  } catch (err: any) {
    logger.error(`Cannot read TEMPLATES_DIR: ${err?.message}`);
    _cache = result;
    _cacheDir = templatesDir;
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const tpl = loadSingleTemplate(path.join(templatesDir, entry.name));
    if (tpl) result.set(tpl.id, tpl);
  }

  logger.info(`Disk templates loaded: ${result.size} from "${templatesDir}"`);
  _cache = result;
  _cacheDir = templatesDir;
  return result;
}

export function invalidateDiskTemplateCache(): void {
  _cache = null;
  _cacheDir = null;
}

export function getTemplatesDir(): string | null {
  return process.env.TEMPLATES_DIR?.trim() || null;
}
