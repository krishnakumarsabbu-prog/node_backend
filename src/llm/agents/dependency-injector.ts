import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";
import type { FileMap } from "../constants";

const logger = createScopedLogger("dependency-injector");

export interface DependencyInjectionResult {
  enrichedStep: PlanStep;
  missingDeps: string[];
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

export function injectMissingDependencies(
  step: PlanStep,
  packageJsonContent: string,
): DependencyInjectionResult {
  const installed = parseInstalledPackages(packageJsonContent);
  const mentioned = extractImportedPackages(step.details);

  const missing = mentioned.filter((pkg) => {
    if (installed.has(pkg)) return false;
    if (COMMON_PACKAGES.has(pkg)) return false;
    if (SCOPED_PACKAGE_PREFIXES.some((prefix) => pkg.startsWith(prefix))) return false;
    return true;
  });

  if (missing.length === 0) {
    return { enrichedStep: step, missingDeps: [], injected: false };
  }

  logger.info(`[dependency-injector] Step ${step.index} missing deps: ${missing.join(", ")}`);

  const injection = `\nPACKAGE REQUIREMENT: Update package.json to add these dependencies before implementing: ${missing.join(", ")}. Output the updated package.json as the first file in your response.`;
  const enrichedDetails = step.details + injection;

  return {
    enrichedStep: { ...step, details: enrichedDetails },
    missingDeps: missing,
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
