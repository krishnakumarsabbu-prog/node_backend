import type { FileMap } from "../constants";

export type Language =
  | "typescript"
  | "javascript"
  | "java"
  | "python"
  | "go"
  | "rust"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "dart"
  | "unknown";

export type Framework =
  | "react"
  | "nextjs"
  | "angular"
  | "vue"
  | "svelte"
  | "solid"
  | "spring-boot"
  | "express"
  | "fastapi"
  | "django"
  | "flask"
  | "rails"
  | "laravel"
  | "gin"
  | "fiber"
  | "nestjs"
  | "hono"
  | "expo"
  | "react-native"
  | "none"
  | "unknown";

export type ProjectType =
  | "frontend"
  | "backend"
  | "fullstack"
  | "cli"
  | "library"
  | "mobile";

export interface ProjectCapabilities {
  routing: boolean;
  navigation: boolean;
  api: boolean;
  database: boolean;
  stateManagement: boolean;
  auth: boolean;
  testing: boolean;
}

export interface ProjectLayers {
  entry: string[];
  routing: string[];
  controller: string[];
  service: string[];
  data: string[];
  ui: string[];
  config: string[];
}

export interface ProjectArchitecture {
  language: Language;
  framework: Framework;
  projectType: ProjectType;
  entryPoints: string[];
  capabilities: ProjectCapabilities;
  layers: ProjectLayers;
  packageManager: "npm" | "yarn" | "pnpm" | "pip" | "maven" | "gradle" | "cargo" | "go" | "unknown";
  testFramework: string | null;
}

function getFilePaths(files: FileMap): string[] {
  return Object.entries(files)
    .filter(([, e]) => e?.type === "file" && !(e as any).isBinary)
    .map(([p]) => p);
}

function getFileContent(files: FileMap, path: string): string {
  const entry = files[path] as any;
  return typeof entry?.content === "string" ? entry.content : "";
}

function findFileByName(paths: string[], name: string): string | null {
  const lower = name.toLowerCase();
  return paths.find((p) => p.split("/").pop()?.toLowerCase() === lower) ?? null;
}

function pathsMatchingGlob(paths: string[], pattern: RegExp): string[] {
  return paths.filter((p) => pattern.test(p));
}

function stripProjectPrefix(path: string): string {
  return path.replace(/^\/home\/project\//, "");
}

export function bootstrapArchitectureFromText(text: string): ProjectArchitecture | null {
  const lower = text.toLowerCase();

  let framework: Framework = "unknown";
  let language: Language = "unknown";
  let projectType: ProjectType = "frontend";

  if (/\bnext\.?js\b/.test(lower)) { framework = "nextjs"; language = "typescript"; projectType = "fullstack"; }
  else if (/\bsvelte\b/.test(lower)) { framework = "svelte"; language = "typescript"; projectType = "frontend"; }
  else if (/\bvue\b/.test(lower)) { framework = "vue"; language = "typescript"; projectType = "frontend"; }
  else if (/\bangular\b/.test(lower)) { framework = "angular"; language = "typescript"; projectType = "frontend"; }
  else if (/\breact\b/.test(lower)) { framework = "react"; language = "typescript"; projectType = "frontend"; }
  else if (/\bfastapi\b/.test(lower)) { framework = "fastapi"; language = "python"; projectType = "backend"; }
  else if (/\bdjango\b/.test(lower)) { framework = "django"; language = "python"; projectType = "backend"; }
  else if (/\bflask\b/.test(lower)) { framework = "flask"; language = "python"; projectType = "backend"; }
  else if (/\bspring[\s-]boot\b/.test(lower)) { framework = "spring-boot"; language = "java"; projectType = "backend"; }
  else if (/\bnestjs\b/.test(lower)) { framework = "nestjs"; language = "typescript"; projectType = "backend"; }
  else if (/\bhono\b/.test(lower)) { framework = "hono"; language = "typescript"; projectType = "backend"; }
  else if (/\bexpress\b/.test(lower)) { framework = "express"; language = "typescript"; projectType = "backend"; }
  else if (/\brails\b/.test(lower)) { framework = "rails"; language = "ruby"; projectType = "backend"; }
  else if (/\blaravel\b/.test(lower)) { framework = "laravel"; language = "php"; projectType = "backend"; }
  else if (/\bgin\b/.test(lower)) { framework = "gin"; language = "go"; projectType = "backend"; }
  else if (/\bfiber\b/.test(lower)) { framework = "fiber"; language = "go"; projectType = "backend"; }
  else if (/\b(web\s*app|portal|dashboard|ecommerce|e-commerce|frontend|ui)\b/.test(lower)) {
    framework = "react"; language = "typescript"; projectType = "frontend";
  } else if (/\b(api|rest|graphql|backend|server|service|microservice)\b/.test(lower)) {
    framework = "express"; language = "typescript"; projectType = "backend";
  }

  if (framework === "unknown") return null;

  const isFrontend = ["react", "nextjs", "angular", "vue", "svelte", "solid"].includes(framework);
  const isBackend = ["spring-boot", "express", "fastapi", "django", "flask", "rails", "laravel", "gin", "fiber", "nestjs", "hono"].includes(framework);

  return {
    language,
    framework,
    projectType,
    entryPoints: [],
    capabilities: {
      routing: isFrontend || framework === "nextjs",
      navigation: isFrontend,
      api: isBackend || framework === "nextjs",
      database: /\b(database|db|postgres|mysql|sqlite|mongodb|prisma|supabase|drizzle)\b/.test(lower),
      stateManagement: /\b(redux|zustand|jotai|recoil|mobx|pinia|ngrx)\b/.test(lower),
      auth: /\b(auth|login|signup|sign[\s-]in|jwt|session|oauth)\b/.test(lower),
      testing: false,
    },
    layers: {
      entry: [],
      routing: [],
      controller: [],
      service: [],
      data: [],
      ui: isFrontend ? ["src/components", "src/pages"] : [],
      config: [],
    },
    packageManager: isBackend && language === "java" ? "maven" : language === "python" ? "pip" : language === "go" ? "go" : "npm",
    testFramework: null,
  };
}

export function detectArchitecture(files: FileMap): ProjectArchitecture {
  const paths = getFilePaths(files);
  const shortPaths = paths.map(stripProjectPrefix);

  const packageJsonPath = findFileByName(paths, "package.json");
  const packageJson = packageJsonPath ? (() => {
    try { return JSON.parse(getFileContent(files, packageJsonPath)); } catch { return {}; }
  })() : {};

  const deps: Record<string, string> = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
  };

  const pomXmlPath = findFileByName(paths, "pom.xml");
  const pomContent = pomXmlPath ? getFileContent(files, pomXmlPath) : "";

  const buildGradlePath = paths.find((p) => p.endsWith("build.gradle") || p.endsWith("build.gradle.kts")) ?? null;
  const buildGradleContent = buildGradlePath ? getFileContent(files, buildGradlePath) : "";

  const requirementsTxtPath = findFileByName(paths, "requirements.txt");
  const pyprojectPath = findFileByName(paths, "pyproject.toml");
  const pipfilePath = findFileByName(paths, "pipfile");

  const goModPath = findFileByName(paths, "go.mod");
  const cargoTomlPath = findFileByName(paths, "cargo.toml");

  const language = detectLanguage(paths, deps, pomContent, buildGradleContent, goModPath, cargoTomlPath, requirementsTxtPath, pyprojectPath, pipfilePath);
  const framework = detectFramework(paths, deps, pomContent, buildGradleContent, files, language);
  const projectType = detectProjectType(framework, paths, deps, language);
  const entryPoints = detectEntryPoints(paths, framework, language, files);
  const capabilities = detectCapabilities(paths, deps, files, framework, language);
  const layers = detectLayers(paths, framework, language);
  const packageManager = detectPackageManager(paths, pomContent, buildGradleContent, goModPath, cargoTomlPath, requirementsTxtPath, pyprojectPath, deps);
  const testFramework = detectTestFramework(deps, paths);

  return {
    language,
    framework,
    projectType,
    entryPoints,
    capabilities,
    layers,
    packageManager,
    testFramework,
  };
}

function detectLanguage(
  paths: string[],
  deps: Record<string, string>,
  pomContent: string,
  buildGradleContent: string,
  goModPath: string | null,
  cargoTomlPath: string | null,
  requirementsTxtPath: string | null,
  pyprojectPath: string | null,
  pipfilePath: string | null,
): Language {
  if (pomContent || buildGradleContent) return "java";
  if (goModPath) return "go";
  if (cargoTomlPath) return "rust";
  if (requirementsTxtPath || pyprojectPath || pipfilePath) return "python";
  if (paths.some((p) => p.endsWith(".swift"))) return "swift";
  if (paths.some((p) => p.endsWith(".dart"))) return "dart";
  if (paths.some((p) => p.endsWith(".rb")) || paths.some((p) => p.endsWith("Gemfile"))) return "ruby";
  if (paths.some((p) => p.endsWith(".php")) || paths.some((p) => p.endsWith("composer.json"))) return "php";
  if (paths.some((p) => p.endsWith(".cs") || p.endsWith(".csproj"))) return "csharp";
  if (paths.some((p) => p.endsWith(".ts") || p.endsWith(".tsx"))) return "typescript";
  if (paths.some((p) => p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs"))) return "javascript";
  if (Object.keys(deps).length > 0) return "javascript";
  return "unknown";
}

function detectFramework(
  paths: string[],
  deps: Record<string, string>,
  pomContent: string,
  buildGradleContent: string,
  files: FileMap,
  language: Language,
): Framework {
  if (deps["next"]) return "nextjs";
  if (deps["expo"]) return "expo";
  if (deps["react-native"]) return "react-native";
  if (deps["@angular/core"]) return "angular";
  if (deps["vue"]) return "vue";
  if (deps["svelte"] || deps["@sveltejs/kit"]) return "svelte";
  if (deps["solid-js"]) return "solid";
  if (deps["react"]) return "react";
  if (deps["@nestjs/core"]) return "nestjs";
  if (deps["hono"]) return "hono";
  if (deps["express"]) return "express";

  if (pomContent.includes("spring-boot") || buildGradleContent.includes("spring-boot")) return "spring-boot";

  const mainPyPath = paths.find((p) => p.endsWith("main.py"));
  if (mainPyPath) {
    const content = getFileContent(files, mainPyPath);
    if (content.includes("FastAPI(")) return "fastapi";
    if (content.includes("Flask(")) return "flask";
  }
  const anyPy = paths.filter((p) => p.endsWith(".py"));
  for (const p of anyPy.slice(0, 10)) {
    const c = getFileContent(files, p);
    if (c.includes("FastAPI(")) return "fastapi";
    if (c.includes("from django") || c.includes("import django")) return "django";
    if (c.includes("Flask(")) return "flask";
  }

  if (paths.some((p) => p.endsWith(".rb"))) {
    const gemfile = paths.find((p) => p.endsWith("Gemfile"));
    if (gemfile && getFileContent(files, gemfile).includes("rails")) return "rails";
  }
  if (paths.some((p) => p.endsWith(".php"))) {
    const composer = paths.find((p) => p.endsWith("composer.json"));
    if (composer && getFileContent(files, composer).includes("laravel")) return "laravel";
  }
  if (language === "go") {
    for (const p of paths.filter((p) => p.endsWith(".go")).slice(0, 10)) {
      const c = getFileContent(files, p);
      if (c.includes('"github.com/gin-gonic/gin"')) return "gin";
      if (c.includes('"github.com/gofiber/fiber')) return "fiber";
    }
  }

  if (language === "java") return "spring-boot";
  if (language === "unknown" && paths.length === 0) return "unknown";
  return "none";
}

function detectProjectType(
  framework: Framework,
  paths: string[],
  deps: Record<string, string>,
  language: Language,
): ProjectType {
  if (framework === "expo" || framework === "react-native") return "mobile";
  if (framework === "nextjs") return "fullstack";
  if (["react", "angular", "vue", "svelte", "solid"].includes(framework)) return "frontend";
  if (["spring-boot", "express", "fastapi", "django", "flask", "rails", "laravel", "gin", "fiber", "nestjs", "hono"].includes(framework)) return "backend";

  const hasUi = paths.some((p) => /\.(tsx|jsx|html|vue|svelte)$/.test(p));
  const hasBackend = paths.some((p) =>
    /\b(controller|service|repository|handler|route|router)\b/i.test(p.split("/").pop() ?? ""),
  );
  if (hasUi && hasBackend) return "fullstack";
  if (hasUi) return "frontend";
  if (hasBackend) return "backend";

  const isCli = !!(deps["commander"] || deps["yargs"] || deps["meow"] || deps["oclif"]);
  if (isCli) return "cli";

  const isLib = !!(packageJsonMainField(deps)) || paths.some((p) => p.endsWith("index.ts") || p.endsWith("index.js"));
  if (isLib && !hasUi) return "library";

  return "backend";
}

function packageJsonMainField(_deps: Record<string, string>): boolean {
  return false;
}

function detectEntryPoints(
  paths: string[],
  framework: Framework,
  language: Language,
  files: FileMap,
): string[] {
  const short = paths.map(stripProjectPrefix);
  const entries: string[] = [];

  const add = (pattern: RegExp) => {
    const found = short.filter((p) => pattern.test(p));
    entries.push(...found);
  };

  if (["react", "nextjs", "angular", "vue", "svelte", "solid"].includes(framework)) {
    add(/^src\/main\.[tj]sx?$/);
    add(/^src\/index\.[tj]sx?$/);
    add(/^main\.[tj]sx?$/);
    add(/^index\.[tj]sx?$/);
    add(/^src\/App\.[tj]sx?$/);
    if (framework === "nextjs") {
      add(/^app\/layout\.[tj]sx?$/);
      add(/^pages\/_app\.[tj]sx?$/);
    }
    if (framework === "angular") {
      add(/^src\/main\.ts$/);
      add(/^src\/app\/app\.module\.ts$/);
    }
  } else if (framework === "expo" || framework === "react-native") {
    add(/^App\.[tj]sx?$/);
    add(/^app\/_layout\.[tj]sx?$/);
    add(/^index\.js$/);
  } else if (framework === "express" || framework === "nestjs" || framework === "hono") {
    add(/^src\/index\.[tj]s$/);
    add(/^src\/main\.[tj]s$/);
    add(/^src\/server\.[tj]s$/);
    add(/^index\.[tj]s$/);
    add(/^server\.[tj]s$/);
  } else if (framework === "spring-boot") {
    add(/Application\.java$/);
  } else if (language === "python") {
    add(/^main\.py$/);
    add(/^app\.py$/);
    add(/^wsgi\.py$/);
    add(/^asgi\.py$/);
    add(/^manage\.py$/);
  } else if (language === "go") {
    add(/^main\.go$/);
    add(/^cmd\/.*\/main\.go$/);
  }

  return [...new Set(entries)].slice(0, 6);
}

function detectCapabilities(
  paths: string[],
  deps: Record<string, string>,
  files: FileMap,
  framework: Framework,
  language: Language,
): ProjectCapabilities {
  const short = paths.map(stripProjectPrefix);
  const allContent = paths
    .slice(0, 30)
    .map((p) => getFileContent(files, p))
    .join("\n");

  const routing = detectRouting(short, deps, allContent, framework, language);
  const navigation = detectNavigation(short, deps, allContent, framework);
  const api = detectApi(short, deps, allContent, framework);
  const database = detectDatabase(deps, allContent);
  const stateManagement = detectStateManagement(deps, allContent);
  const auth = detectAuth(deps, allContent);
  const testing = detectTesting(deps, short);

  return { routing, navigation, api, database, stateManagement, auth, testing };
}

function detectRouting(
  short: string[],
  deps: Record<string, string>,
  content: string,
  framework: Framework,
  language: Language,
): boolean {
  if (["react", "nextjs"].includes(framework)) {
    if (deps["react-router"] || deps["react-router-dom"] || deps["@tanstack/router"]) return true;
    if (content.includes("<Route") || content.includes("createBrowserRouter") || content.includes("useNavigate")) return true;
    if (framework === "nextjs") return true;
    if (short.some((p) => /\bpages?\b/.test(p) || /\brouter?\b/.test(p))) return true;
  }
  if (framework === "angular") return true;
  if (framework === "vue") {
    if (deps["vue-router"]) return true;
    if (content.includes("createRouter") || content.includes("<router-view")) return true;
  }
  if (["express", "nestjs", "hono", "fastapi", "django", "rails", "laravel", "gin", "fiber", "spring-boot"].includes(framework)) return true;
  if (language === "go" && (content.includes(".HandleFunc(") || content.includes(".GET(") || content.includes(".POST("))) return true;
  if (language === "java" && (content.includes("@RequestMapping") || content.includes("@GetMapping") || content.includes("@PostMapping"))) return true;
  return false;
}

function detectNavigation(
  short: string[],
  deps: Record<string, string>,
  content: string,
  framework: Framework,
): boolean {
  if (["backend", "cli", "library"].includes(framework)) return false;
  if (content.includes("<Link") || content.includes("<NavLink") || content.includes("useNavigate")) return true;
  if (content.includes("<a href") || content.includes("<nav")) return true;
  if (short.some((p) => /\bnav(bar|igation)?\b/i.test(p) || /\bsidebar\b/i.test(p))) return true;
  if (deps["react-router-dom"] || deps["@reach/router"]) return true;
  return false;
}

function detectApi(
  short: string[],
  deps: Record<string, string>,
  content: string,
  framework: Framework,
): boolean {
  if (["express", "nestjs", "hono", "fastapi", "django", "flask", "rails", "laravel", "gin", "fiber", "spring-boot"].includes(framework)) return true;
  if (short.some((p) => /\bapi\b/i.test(p) || /\bendpoint\b/i.test(p) || /\broute\b/i.test(p))) return true;
  if (content.includes("fetch(") || content.includes("axios") || content.includes("useQuery") || content.includes("useSWR")) return true;
  if (deps["axios"] || deps["swr"] || deps["@tanstack/react-query"]) return true;
  return false;
}

function detectDatabase(deps: Record<string, string>, content: string): boolean {
  const dbDeps = ["prisma", "@prisma/client", "mongoose", "sequelize", "typeorm", "drizzle-orm", "knex", "pg", "mysql2", "sqlite3", "better-sqlite3", "@supabase/supabase-js", "firebase"];
  if (dbDeps.some((d) => deps[d])) return true;
  if (content.includes("@Entity") || content.includes("@Table") || content.includes("@Column")) return true;
  if (content.includes("prisma.") || content.includes("mongoose.") || content.includes("db.query(")) return true;
  return false;
}

function detectStateManagement(deps: Record<string, string>, content: string): boolean {
  const stateDeps = ["zustand", "jotai", "recoil", "redux", "@reduxjs/toolkit", "mobx", "valtio", "nanostores", "pinia", "vuex", "ngrx"];
  if (stateDeps.some((d) => deps[d])) return true;
  if (content.includes("createStore") || content.includes("useReducer") || content.includes("createSlice")) return true;
  return false;
}

function detectAuth(deps: Record<string, string>, content: string): boolean {
  const authDeps = ["@supabase/supabase-js", "firebase", "next-auth", "@auth/core", "passport", "jsonwebtoken", "clerk", "auth0", "@okta/okta-sdk-nodejs"];
  if (authDeps.some((d) => deps[d])) return true;
  if (content.includes("signIn") || content.includes("signUp") || content.includes("useSession") || content.includes("JWT") || content.includes("bcrypt")) return true;
  return false;
}

function detectTesting(deps: Record<string, string>, short: string[]): boolean {
  const testDeps = ["vitest", "jest", "cypress", "playwright", "@testing-library/react", "mocha", "chai", "supertest"];
  if (testDeps.some((d) => deps[d])) return true;
  if (short.some((p) => /\.(spec|test)\.[tj]sx?$/.test(p))) return true;
  return false;
}

function detectLayers(paths: string[], framework: Framework, language: Language): ProjectLayers {
  const short = paths.map(stripProjectPrefix);

  const match = (patterns: RegExp[]): string[] => {
    const results: string[] = [];
    for (const p of short) {
      if (patterns.some((re) => re.test(p))) results.push(p);
    }
    return [...new Set(results)];
  };

  if (["react", "nextjs", "angular", "vue", "svelte", "solid"].includes(framework)) {
    return {
      entry: match([/^src\/main\.[tj]sx?$/, /^src\/index\.[tj]sx?$/, /^src\/App\.[tj]sx?$/, /^app\/layout\.[tj]sx?$/, /^pages\/_app\.[tj]sx?$/]),
      routing: match([/\brouter\b/i, /\bApp\.[tj]sx?$/, /\broutes?\b/i, /^app\/.*\/_?layout\.[tj]sx?$/]),
      controller: [],
      service: match([/\bservices?\//i, /\bapi\//i, /\bhooks?\//i]),
      data: match([/\bstore\b/i, /\bslice\b/i, /\breducer\b/i, /\bcontext\b/i, /\bstate\b/i]),
      ui: match([/\bcomponents?\//i, /\bpages?\//i, /\bviews?\//i, /\blayouts?\//i, /\bscreens?\//i]),
      config: match([/\btailwind\.config\b/, /\bvite\.config\b/, /\bnext\.config\b/, /\btsconfig\b/, /\.env/]),
    };
  }

  if (["express", "nestjs", "hono"].includes(framework)) {
    return {
      entry: match([/^src\/index\.[tj]s$/, /^src\/main\.[tj]s$/, /^src\/server\.[tj]s$/, /^index\.[tj]s$/, /^server\.[tj]s$/]),
      routing: match([/\broutes?\//i, /\bapp\.[tj]s$/, /\bserver\.[tj]s$/]),
      controller: match([/\bcontrollers?\//i, /\.controller\.[tj]s$/]),
      service: match([/\bservices?\//i, /\.service\.[tj]s$/]),
      data: match([/\bmodels?\//i, /\bschemas?\//i, /\brepositories?\//i, /\.model\.[tj]s$/, /\.schema\.[tj]s$/]),
      ui: [],
      config: match([/\bconfig\//i, /\.env/, /\btsconfig\b/]),
    };
  }

  if (framework === "spring-boot") {
    return {
      entry: match([/Application\.java$/]),
      routing: match([/Controller\.java$/]),
      controller: match([/Controller\.java$/]),
      service: match([/Service\.java$/]),
      data: match([/Repository\.java$/, /Entity\.java$/, /\.java$/.source ? [/Repository\.java$/, /Entity\.java$/] : [/Repository\.java$/]].flat()),
      ui: [],
      config: match([/application\.(yml|yaml|properties)$/, /pom\.xml$/, /build\.gradle/]),
    };
  }

  if (language === "python") {
    return {
      entry: match([/^main\.py$/, /^app\.py$/, /^wsgi\.py$/, /^manage\.py$/]),
      routing: match([/\broutes?\b/i, /\burls?\.py$/]),
      controller: match([/\bviews?\.py$/, /\bhandlers?\b/i]),
      service: match([/\bservices?\//i, /\butils?\b/i]),
      data: match([/\bmodels?\.py$/, /\bschemas?\b/i, /\brepositories?\b/i]),
      ui: match([/\btemplates?\//i, /\bstatic\//i]),
      config: match([/settings?\.py$/, /config\.py$/, /\.env/, /requirements\.txt$/, /pyproject\.toml$/]),
    };
  }

  if (language === "go") {
    return {
      entry: match([/^main\.go$/, /cmd\/.*\/main\.go$/]),
      routing: match([/\brouter\b/i, /\bhandler\b/i]),
      controller: match([/\bhandlers?\b/i]),
      service: match([/\bservices?\b/i, /\bpkg\b/i]),
      data: match([/\bmodels?\b/i, /\brepositories?\b/i, /\bstore\b/i]),
      ui: [],
      config: match([/go\.mod$/, /\.env/, /config\.(go|yaml|json)/]),
    };
  }

  return {
    entry: [],
    routing: [],
    controller: [],
    service: [],
    data: [],
    ui: [],
    config: [],
  };
}

function detectPackageManager(
  paths: string[],
  pomContent: string,
  buildGradleContent: string,
  goModPath: string | null,
  cargoTomlPath: string | null,
  requirementsTxtPath: string | null,
  pyprojectPath: string | null,
  deps: Record<string, string>,
): ProjectArchitecture["packageManager"] {
  if (pomContent) return "maven";
  if (buildGradleContent) return "gradle";
  if (goModPath) return "go";
  if (cargoTomlPath) return "cargo";
  if (requirementsTxtPath || pyprojectPath) return "pip";
  if (Object.keys(deps).length > 0 || paths.some((p) => p.endsWith("package.json"))) {
    if (paths.some((p) => p.endsWith("pnpm-lock.yaml"))) return "pnpm";
    if (paths.some((p) => p.endsWith("yarn.lock"))) return "yarn";
    return "npm";
  }
  return "unknown";
}

function detectTestFramework(deps: Record<string, string>, paths: string[]): string | null {
  if (deps["vitest"]) return "vitest";
  if (deps["jest"] || deps["@jest/core"]) return "jest";
  if (deps["cypress"]) return "cypress";
  if (deps["playwright"] || deps["@playwright/test"]) return "playwright";
  if (deps["mocha"]) return "mocha";
  const short = paths.map(stripProjectPrefix);
  if (short.some((p) => /vitest\.config/.test(p))) return "vitest";
  if (short.some((p) => /jest\.config/.test(p))) return "jest";
  return null;
}
