import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";
import type { FileMap } from "../constants";

const logger = createScopedLogger("dependency-injector");

export interface DependencyInjectionResult {
  enrichedStep: PlanStep;
  missingDeps: string[];
  semanticHints: string[];
  injected: boolean;
}

const COMMON_PACKAGES = new Set([
  "react", "react-dom", "react-router-dom", "react-router",
  "next", "nuxt", "vue", "svelte",
  "express", "fastify", "koa", "hono",
  "typescript", "vite", "webpack", "rollup", "esbuild",
  "tailwindcss", "postcss", "autoprefixer",
  "@supabase/supabase-js", "@supabase/ssr",
  "axios", "swr", "react-query", "@tanstack/react-query",
  "zustand", "jotai", "recoil", "mobx",
  "zod", "yup", "joi",
  "date-fns", "dayjs", "moment",
  "lodash", "lodash-es", "ramda",
  "clsx", "classnames",
  "lucide-react", "@heroicons/react", "react-icons",
  "framer-motion", "react-spring",
  "chart.js", "recharts", "d3",
  "stripe", "@stripe/stripe-js",
  "socket.io", "socket.io-client",
  "prisma", "@prisma/client", "drizzle-orm",
  "redis", "ioredis",
  "nodemailer", "resend",
  "jsonwebtoken", "bcrypt", "bcryptjs",
  "dotenv",
  "vitest", "jest", "@testing-library/react", "cypress", "playwright",
]);

const SCOPED_PACKAGE_PREFIXES = [
  "@radix-ui/", "@headlessui/", "@shadcn/", "@mui/",
  "@chakra-ui/", "@emotion/", "@tanstack/", "@types/",
];

const IMPORT_RE = /(?:import|from)\s+['"]([^'"./][^'"]*)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;

interface SemanticRule {
  pattern: RegExp;
  hint: string;
  suggestedPackages: string[];
}

const SEMANTIC_RULES: SemanticRule[] = [
  {
    pattern: /\b(fetch|axios|http\s+(?:get|post|put|delete|request)|REST\s+API|api\s+call|HTTP\s+client)\b/i,
    hint: "HTTP client usage detected",
    suggestedPackages: ["axios"],
  },
  {
    pattern: /\b(useQuery|useMutation|QueryClient|React\s+Query|TanStack\s+Query|server\s+state)\b/i,
    hint: "Server state management detected",
    suggestedPackages: ["@tanstack/react-query"],
  },
  {
    pattern: /\b(zustand|jotai|recoil|redux|MobX|global\s+state\s+store|state\s+management\s+library)\b/i,
    hint: "Client state management library detected",
    suggestedPackages: ["zustand"],
  },
  {
    pattern: /\b(Prisma|@PrismaClient|prisma\.(?:user|post|product|order)|ORM|database\s+schema|database\s+migration)\b/i,
    hint: "ORM/database schema usage detected",
    suggestedPackages: ["prisma", "@prisma/client"],
  },
  {
    pattern: /\b(drizzle|drizzle-orm|pgTable|mysqlTable|sqliteTable)\b/i,
    hint: "Drizzle ORM usage detected",
    suggestedPackages: ["drizzle-orm"],
  },
  {
    pattern: /\b(Supabase|createClient|supabase\.from|supabase\.auth|supabaseUrl|supabaseKey)\b/i,
    hint: "Supabase client usage detected",
    suggestedPackages: ["@supabase/supabase-js"],
  },
  {
    pattern: /\b(stripe\.(?:checkout|paymentIntent|subscription)|Stripe\s+webhook|payment\s+processing|checkout\s+session)\b/i,
    hint: "Stripe payment processing detected",
    suggestedPackages: ["stripe"],
  },
  {
    pattern: /\b(socket\.io|WebSocket|real[-\s]time|live\s+updates|event\s+emitter)\b/i,
    hint: "Real-time / WebSocket usage detected",
    suggestedPackages: ["socket.io", "socket.io-client"],
  },
  {
    pattern: /\b(sendEmail|nodemailer|transporter|SMTP|email\s+template|email\s+notification)\b/i,
    hint: "Email sending detected",
    suggestedPackages: ["nodemailer"],
  },
  {
    pattern: /\b(Resend|resend\.emails\.send)\b/i,
    hint: "Resend email API detected",
    suggestedPackages: ["resend"],
  },
  {
    pattern: /\b(framer[- ]motion|animate|motion\.div|AnimatePresence|spring\s+animation|page\s+transition)\b/i,
    hint: "Animation library usage detected",
    suggestedPackages: ["framer-motion"],
  },
  {
    pattern: /\b(recharts|BarChart|LineChart|PieChart|AreaChart|chart\s+component|data\s+visualization)\b/i,
    hint: "Charting/data visualization detected",
    suggestedPackages: ["recharts"],
  },
  {
    pattern: /\b(bcrypt|hashPassword|comparePassword|password\s+hashing)\b/i,
    hint: "Password hashing detected",
    suggestedPackages: ["bcryptjs"],
  },
  {
    pattern: /\b(jwt|jsonwebtoken|sign\s+token|verify\s+token|JWT\s+auth|Bearer\s+token)\b/i,
    hint: "JWT authentication detected",
    suggestedPackages: ["jsonwebtoken"],
  },
  {
    pattern: /\b(Redis|ioredis|cache\s+layer|rate\s+limit\s+with\s+redis|session\s+store)\b/i,
    hint: "Redis/caching layer detected",
    suggestedPackages: ["ioredis"],
  },
  {
    pattern: /\b(zod\s+schema|z\.object|z\.string|z\.number|input\s+validation\s+schema|form\s+validation\s+with)\b/i,
    hint: "Schema validation with Zod detected",
    suggestedPackages: ["zod"],
  },
  {
    pattern: /\b(date-fns|dayjs|format\s+date|parse\s+date|date\s+manipulation)\b/i,
    hint: "Date utility library detected",
    suggestedPackages: ["date-fns"],
  },
  {
    pattern: /\b(sharp|image\s+resize|image\s+optimization|image\s+processing)\b/i,
    hint: "Image processing detected",
    suggestedPackages: ["sharp"],
  },
  {
    pattern: /\b(multer|file\s+upload|multipart\s+form|upload\s+middleware)\b/i,
    hint: "File upload handling detected",
    suggestedPackages: ["multer"],
  },
  {
    pattern: /\b(Spring\s+Boot|@SpringBootApplication|@RestController|spring[-\s]starter)\b/i,
    hint: "Spring Boot detected — ensure spring-boot-starter dependencies are present",
    suggestedPackages: [],
  },
  {
    pattern: /\b(@Repository|@Service|@Component|@Autowired|dependency\s+injection\s+annotation)\b/i,
    hint: "Spring annotations detected — ensure spring-context dependency is present",
    suggestedPackages: [],
  },
];

function extractImportedPackages(text: string): string[] {
  const packages = new Set<string>();

  for (const template of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    const re = new RegExp(template.source, template.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const full = m[1];
      const pkg = full.startsWith("@")
        ? full.split("/").slice(0, 2).join("/")
        : full.split("/")[0];
      if (pkg && !pkg.startsWith("node:") && !pkg.startsWith("bun:") && !pkg.startsWith("deno:")) {
        packages.add(pkg);
      }
    }
  }

  return [...packages];
}

function parseInstalledPackages(packageJsonContent: string): Set<string> {
  const installed = new Set<string>();
  try {
    const parsed = JSON.parse(packageJsonContent);
    const allDeps = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.peerDependencies,
    };
    for (const key of Object.keys(allDeps)) {
      installed.add(key);
    }
  } catch {
  }
  return installed;
}

function runSemanticRules(
  stepText: string,
  installed: Set<string>,
): { hints: string[]; suggestedMissing: string[] } {
  const hints: string[] = [];
  const suggestedMissing: string[] = [];

  for (const rule of SEMANTIC_RULES) {
    if (!rule.pattern.test(stepText)) continue;

    const actuallyMissing = rule.suggestedPackages.filter(
      (pkg) => !installed.has(pkg) && !COMMON_PACKAGES.has(pkg),
    );

    if (actuallyMissing.length > 0) {
      hints.push(`${rule.hint} — consider adding: ${actuallyMissing.join(", ")}`);
      suggestedMissing.push(...actuallyMissing);
    } else if (rule.suggestedPackages.length === 0 && rule.hint) {
      hints.push(rule.hint);
    }
  }

  return { hints, suggestedMissing: [...new Set(suggestedMissing)] };
}

export function injectMissingDependencies(
  step: PlanStep,
  packageJsonContent: string,
): DependencyInjectionResult {
  const installed = parseInstalledPackages(packageJsonContent);
  const mentioned = extractImportedPackages(step.details);

  const missingFromImports = mentioned.filter((pkg) => {
    if (installed.has(pkg)) return false;
    if (COMMON_PACKAGES.has(pkg)) return false;
    if (SCOPED_PACKAGE_PREFIXES.some((prefix) => pkg.startsWith(prefix))) return false;
    return true;
  });

  const { hints: semanticHints, suggestedMissing } = runSemanticRules(
    step.heading + " " + step.details,
    installed,
  );

  const allMissing = [...new Set([...missingFromImports, ...suggestedMissing])];

  if (allMissing.length === 0 && semanticHints.length === 0) {
    return { enrichedStep: step, missingDeps: [], semanticHints: [], injected: false };
  }

  const parts: string[] = [];

  if (allMissing.length > 0) {
    logger.info(`[dependency-injector] Step ${step.index} missing deps: ${allMissing.join(", ")}`);
    parts.push(
      `PACKAGE REQUIREMENT: Update package.json to add these dependencies before implementing: ${allMissing.join(", ")}. Output the updated package.json as the first file in your response.`,
    );
  }

  if (semanticHints.length > 0) {
    logger.info(`[dependency-injector] Step ${step.index} semantic hints: ${semanticHints.join("; ")}`);
    parts.push(`DEPENDENCY HINTS: ${semanticHints.join("; ")}`);
  }

  const enrichedDetails = step.details + "\n" + parts.join("\n");

  return {
    enrichedStep: { ...step, details: enrichedDetails },
    missingDeps: allMissing,
    semanticHints,
    injected: true,
  };
}

export function extractPackageJson(files: FileMap): string {
  const key = Object.keys(files).find(
    (p) => p.endsWith("/package.json") || p === "package.json",
  );
  if (!key) return "{}";
  const entry = files[key];
  if (entry && entry.type === "file" && typeof entry.content === "string") {
    return entry.content;
  }
  return "{}";
}
