import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("test-file-validator");

export interface TestFileValidationResult {
  valid: boolean;
  issues: string[];
  score: number;
}

const DESCRIBE_RE = /\bdescribe\s*\(/;
const IT_OR_TEST_RE = /\b(it|test)\s*\(/;
const EXPECT_OR_ASSERT_RE = /\b(expect|assert)\s*\(/;

const KNOWN_TEST_IMPORTS: Record<string, RegExp> = {
  vitest: /from\s+['"]vitest['"]/,
  jest: /from\s+['"]@jest\/globals['"]|require\s*\(\s*['"]jest['"]\s*\)/,
  mocha: /from\s+['"]mocha['"]|require\s*\(\s*['"]mocha['"]\s*\)/,
  playwright: /from\s+['"]@playwright\/test['"]/,
  cypress: /from\s+['"]cypress['"]/,
};

function detectTestFrameworkInOutput(output: string): string | null {
  for (const [fw, re] of Object.entries(KNOWN_TEST_IMPORTS)) {
    if (re.test(output)) return fw;
  }
  return null;
}

export function validateTestFileOutput(
  filePath: string,
  output: string,
  expectedTestFramework: string | null,
): TestFileValidationResult {
  const issues: string[] = [];
  let score = 0;

  const hasDescribe = DESCRIBE_RE.test(output);
  const hasTestBlock = IT_OR_TEST_RE.test(output);
  const hasAssertion = EXPECT_OR_ASSERT_RE.test(output);
  const detectedFramework = detectTestFrameworkInOutput(output);

  if (hasDescribe) score += 30;
  else issues.push("MISSING_DESCRIBE: No describe() block found in test output");

  if (hasTestBlock) score += 30;
  else issues.push("MISSING_TEST_BLOCK: No it() or test() blocks found in test output");

  if (hasAssertion) score += 25;
  else issues.push("MISSING_ASSERTION: No expect() or assert() calls found");

  if (detectedFramework) {
    score += 15;
    if (expectedTestFramework && detectedFramework !== expectedTestFramework) {
      issues.push(
        `WRONG_FRAMEWORK: Output uses "${detectedFramework}" but project uses "${expectedTestFramework}"`,
      );
      score -= 15;
    }
  } else if (expectedTestFramework) {
    issues.push(`MISSING_FRAMEWORK_IMPORT: Expected import from "${expectedTestFramework}" not found`);
  }

  const valid = score >= 60 && !issues.some((i) => i.startsWith("MISSING_DESCRIBE") || i.startsWith("MISSING_TEST_BLOCK"));

  logger.info(
    `[test-file-validator] ${filePath} score=${score}/100 valid=${valid}${issues.length ? " issues=" + issues.join(";") : ""}`,
  );

  return { valid, issues, score };
}
