import { generateText } from "ai";
import { getTachyonModel } from "../modules/llm/providers/tachyon.js";
import { createScopedLogger } from "../utils/logger.js";
import { loadDiskTemplates, getTemplatesDir } from "./disk-template-loader.js";
import type { DiskTemplate } from "./disk-template-loader.js";

const logger = createScopedLogger("template-detector");

export type TemplateId = string;

export interface TemplateDetectionResult {
  templateId: TemplateId;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export interface TemplateScaffold {
  templateId: TemplateId;
  files: Record<string, string>;
  installCommand: string;
  startCommand: string;
  description: string;
  fromDisk?: boolean;
}

const BUILTIN_TEMPLATES: Record<string, { description: string; scaffold: () => TemplateScaffold }> = {
  "react-vite-ts": {
    description: "React + Vite + TypeScript + Tailwind CSS — best for type-safe web apps, dashboards, SPAs",
    scaffold: () => ({
      templateId: "react-vite-ts",
      description: "React + Vite + TypeScript + Tailwind CSS",
      installCommand: "npm install",
      startCommand: "npm run dev",
      files: {
        "package.json": JSON.stringify({
          name: "my-app",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@types/react": "^18.3.5",
            "@types/react-dom": "^18.3.0",
            "@vitejs/plugin-react": "^4.3.1",
            autoprefixer: "^10.4.19",
            postcss: "^8.4.40",
            tailwindcss: "^3.4.7",
            typescript: "^5.5.3",
            vite: "^5.4.1",
          },
        }, null, 2),
        "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
        "vite.config.ts": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`,
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            useDefineForClassFields: true,
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            jsx: "react-jsx",
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ["src"],
        }, null, 2),
        "tailwind.config.js": `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
}`,
        "postcss.config.js": `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}`,
        "src/main.tsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)`,
        "src/index.css": `@tailwind base;
@tailwind components;
@tailwind utilities;`,
        "src/App.tsx": `export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <h1 className="text-2xl font-bold text-gray-900">Hello World</h1>
    </div>
  )
}`,
      },
    }),
  },

  "react-vite": {
    description: "React + Vite + JavaScript + Tailwind CSS — best for standard web apps without TypeScript",
    scaffold: () => ({
      templateId: "react-vite",
      description: "React + Vite + JavaScript + Tailwind CSS",
      installCommand: "npm install",
      startCommand: "npm run dev",
      files: {
        "package.json": JSON.stringify({
          name: "my-app",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@vitejs/plugin-react": "^4.3.1",
            autoprefixer: "^10.4.19",
            postcss: "^8.4.40",
            tailwindcss: "^3.4.7",
            vite: "^5.4.1",
          },
        }, null, 2),
        "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
        "vite.config.js": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })`,
        "tailwind.config.js": `export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
}`,
        "postcss.config.js": `export default { plugins: { tailwindcss: {}, autoprefixer: {} } }`,
        "src/main.jsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)`,
        "src/index.css": `@tailwind base;\n@tailwind components;\n@tailwind utilities;`,
        "src/App.jsx": `export default function App() {
  return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><h1 className="text-2xl font-bold">Hello World</h1></div>
}`,
      },
    }),
  },

  "node-express": {
    description: "Node.js + Express + TypeScript — best for REST APIs, backend services, MCP servers",
    scaffold: () => ({
      templateId: "node-express",
      description: "Node.js + Express + TypeScript",
      installCommand: "npm install",
      startCommand: "npm run dev",
      files: {
        "package.json": JSON.stringify({
          name: "my-api",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: { dev: "tsx src/index.ts", build: "tsc", start: "node dist/index.js" },
          dependencies: { express: "^4.19.2", cors: "^2.8.5" },
          devDependencies: {
            "@types/cors": "^2.8.17",
            "@types/express": "^4.17.21",
            "@types/node": "^20.11.0",
            tsx: "^4.7.0",
            typescript: "^5.3.3",
          },
        }, null, 2),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "node",
            outDir: "./dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ["src"],
        }, null, 2),
        "src/index.ts": `import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

app.listen(3000, () => console.log('Server running at http://localhost:3000'))`,
      },
    }),
  },

  "nextjs": {
    description: "Next.js + App Router + TypeScript — best for SSR, SEO-heavy apps, e-commerce, blogs",
    scaffold: () => ({
      templateId: "nextjs",
      description: "Next.js + App Router + TypeScript",
      installCommand: "npm install",
      startCommand: "npm run dev",
      files: {
        "package.json": JSON.stringify({
          name: "my-next-app",
          private: true,
          version: "0.0.0",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^14.2.5", react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@types/node": "^20.11.0",
            "@types/react": "^18.3.5",
            "@types/react-dom": "^18.3.0",
            typescript: "^5.5.3",
          },
        }, null, 2),
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        }, null, 2),
        "app/layout.tsx": `import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My App',
  description: 'Generated by Cortex',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}`,
        "app/page.tsx": `export default function Home() {
  return <main><h1>Hello World</h1></main>
}`,
      },
    }),
  },

  "vanilla-vite": {
    description: "Vanilla JavaScript + Vite — best for simple demos, games, prototypes",
    scaffold: () => ({
      templateId: "vanilla-vite",
      description: "Vanilla JavaScript + Vite",
      installCommand: "npm install",
      startCommand: "npm run dev",
      files: {
        "package.json": JSON.stringify({
          name: "my-app",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          devDependencies: { vite: "^5.4.1" },
        }, null, 2),
        "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`,
        "src/main.js": `document.querySelector('#app').innerHTML = '<h1>Hello World</h1>'`,
        "src/style.css": `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; }`,
      },
    }),
  },
};

function getAllTemplates(): Array<{ id: string; description: string }> {
  const dir = getTemplatesDir();
  const diskTemplates = dir ? loadDiskTemplates(dir) : new Map<string, DiskTemplate>();

  const merged: Array<{ id: string; description: string }> = [];

  for (const [id, tpl] of diskTemplates) {
    merged.push({ id, description: tpl.description });
  }

  for (const [id, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
    if (!diskTemplates.has(id)) {
      merged.push({ id, description: tpl.description });
    }
  }

  return merged;
}

export async function detectTemplate(userRequest: string): Promise<TemplateDetectionResult> {
  logger.info(`Detecting template for: "${userRequest.substring(0, 100)}"`);

  const templates = getAllTemplates();
  const templateList = templates.map((t) => `- ${t.id}: ${t.description}`).join("\n");
  const defaultId = templates.find((t) => t.id === "react-vite-ts")?.id ?? templates[0]?.id ?? "react-vite-ts";

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: `You are a software architect. Given a user's project request, select the most appropriate starter template.

Available templates:
${templateList}

Return ONLY a valid JSON object with:
{
  "templateId": "<one of the template IDs above>",
  "confidence": "high|medium|low",
  "reasoning": "<one sentence explaining the choice>"
}

Rules:
- Default to "${defaultId}" for web apps without a clear framework preference
- Match the user's explicit technology mentions (React, Java, .NET, Vue, etc.) to the template ID
- Do NOT wrap output in markdown fences`,
      prompt: `User request: "${userRequest}"

Select the best template and return JSON.`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as TemplateDetectionResult;

    const valid = templates.some((t) => t.id === parsed.templateId);
    if (!valid) {
      logger.warn(`LLM returned unknown templateId: ${parsed.templateId}, falling back to ${defaultId}`);
      return { templateId: defaultId, confidence: "low", reasoning: "Fallback to default template" };
    }

    logger.info(`Template detected: ${parsed.templateId} (${parsed.confidence})`);
    return parsed;
  } catch (err: any) {
    logger.error(`Template detection failed: ${err?.message}`, err);
    return { templateId: defaultId, confidence: "low", reasoning: "Error during detection, using default" };
  }
}

export function getTemplateScaffold(templateId: string): TemplateScaffold {
  const dir = getTemplatesDir();
  if (dir) {
    const diskTemplates = loadDiskTemplates(dir);
    const disk = diskTemplates.get(templateId);
    if (disk) {
      logger.info(`Serving disk template: "${templateId}"`);
      return {
        templateId: disk.id,
        description: disk.description,
        installCommand: disk.installCommand,
        startCommand: disk.startCommand,
        files: disk.files,
        fromDisk: true,
      };
    }
  }

  const builtin = BUILTIN_TEMPLATES[templateId];
  if (builtin) {
    logger.info(`Serving built-in template: "${templateId}"`);
    return builtin.scaffold();
  }

  logger.warn(`Unknown template "${templateId}", falling back to react-vite-ts`);
  return BUILTIN_TEMPLATES["react-vite-ts"].scaffold();
}

export function listTemplates(): Array<{ id: string; description: string; fromDisk: boolean }> {
  const dir = getTemplatesDir();
  const diskTemplates = dir ? loadDiskTemplates(dir) : new Map<string, DiskTemplate>();
  const result: Array<{ id: string; description: string; fromDisk: boolean }> = [];

  for (const [id, tpl] of diskTemplates) {
    result.push({ id, description: tpl.description, fromDisk: true });
  }

  for (const [id, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
    if (!diskTemplates.has(id)) {
      result.push({ id, description: tpl.description, fromDisk: false });
    }
  }

  return result;
}
