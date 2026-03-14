import { generateText } from "ai";
import { getTachyonModel } from "../modules/llm/providers/tachyon";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("template-detector");

export type TemplateId =
  | "react-vite"
  | "react-vite-ts"
  | "nextjs"
  | "vue-vite"
  | "svelte-vite"
  | "node-express"
  | "react-native-expo"
  | "vanilla-vite"
  | "remix"
  | "astro";

export interface TemplateDetectionResult {
  templateId: TemplateId;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const TEMPLATE_DESCRIPTIONS: Record<TemplateId, string> = {
  "react-vite": "React with Vite, JavaScript, Tailwind CSS — best for standard web apps, dashboards, SPAs",
  "react-vite-ts": "React with Vite, TypeScript, Tailwind CSS — best for type-safe web apps with complex state",
  "nextjs": "Next.js with App Router, TypeScript — best for SSR, SEO-heavy apps, e-commerce, blogs",
  "vue-vite": "Vue 3 with Vite, TypeScript — best for Vue-based SPAs",
  "svelte-vite": "Svelte with Vite — best for lightweight, performance-first apps",
  "node-express": "Node.js with Express, TypeScript — best for REST APIs, backend services",
  "react-native-expo": "React Native with Expo — best for iOS/Android mobile apps",
  "vanilla-vite": "Vanilla JavaScript with Vite — best for simple demos, games, prototypes",
  "remix": "Remix with TypeScript — best for full-stack web apps with nested routing",
  "astro": "Astro — best for content-heavy sites, blogs, documentation",
};

export async function detectTemplate(userRequest: string): Promise<TemplateDetectionResult> {
  logger.info(`Detecting template for: "${userRequest.substring(0, 100)}"`);

  const templateList = Object.entries(TEMPLATE_DESCRIPTIONS)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join("\n");

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
- Default to "react-vite-ts" for web apps without a clear framework preference
- Use "react-native-expo" ONLY if explicitly mobile/iOS/Android
- Use "node-express" ONLY for pure backend/API projects
- Use "nextjs" for apps needing SSR, SEO, or full-stack
- Do NOT wrap output in markdown fences`,
      prompt: `User request: "${userRequest}"

Select the best template and return JSON.`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as TemplateDetectionResult;

    if (!TEMPLATE_DESCRIPTIONS[parsed.templateId]) {
      logger.warn(`LLM returned unknown templateId: ${parsed.templateId}, falling back to react-vite-ts`);
      return { templateId: "react-vite-ts", confidence: "low", reasoning: "Fallback to default template" };
    }

    logger.info(`Template detected: ${parsed.templateId} (${parsed.confidence})`);
    return parsed;
  } catch (err: any) {
    logger.error(`Template detection failed: ${err?.message}`, err);
    return { templateId: "react-vite-ts", confidence: "low", reasoning: "Error during detection, using default" };
  }
}

export interface TemplateScaffold {
  templateId: TemplateId;
  files: Record<string, string>;
  installCommand: string;
  startCommand: string;
  description: string;
}

export function getTemplateScaffold(templateId: TemplateId): TemplateScaffold {
  switch (templateId) {
    case "react-vite-ts":
      return {
        templateId,
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
      };

    case "react-vite":
      return {
        templateId,
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
      };

    case "node-express":
      return {
        templateId,
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
      };

    case "vanilla-vite":
      return {
        templateId,
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
      };

    default:
      return getTemplateScaffold("react-vite-ts");
  }
}
