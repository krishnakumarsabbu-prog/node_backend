import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("static-validator");

export interface StaticValidationIssue {
  file: string;
  type:
    | "field-injection"
    | "duplicate-bean"
    | "xml-reference"
    | "missing-annotation"
    | "missing-main"
    | "javax-import"
    | "enable-web-mvc-conflict"
    | "missing-stereotype"
    | "missing-transaction-enable"
    | "missing-security-filter-chain"
    | "jndi-reference"
    | "deprecated-api"
    | "missing-request-mapping"
    | "value-field-injection"
    | "missing-config-annotation";
  message: string;
  severity: "error" | "warning";
}

export interface StaticValidationResult {
  passed: boolean;
  issues: StaticValidationIssue[];
  fieldInjectionFiles: string[];
  duplicateBeans: string[];
  xmlReferenceFiles: string[];
  hasMainClass: boolean;
}

export function runStaticValidation(fileMap: Map<string, string>): StaticValidationResult {
  logger.info(`Running static validation on ${fileMap.size} files`);

  const issues: StaticValidationIssue[] = [];
  const fieldInjectionFiles: string[] = [];
  const xmlReferenceFiles: string[] = [];
  const beanRegistry = new Map<string, string[]>();
  let hasMainClass = false;

  let hasTransactionManager = false;
  let hasSecurityConfig = false;

  for (const [path, content] of fileMap) {
    if (!path.endsWith(".java")) continue;

    checkFieldInjection(path, content, issues, fieldInjectionFiles);
    checkXmlReferences(path, content, issues, xmlReferenceFiles);
    checkMainClass(path, content, issues);
    collectBeans(path, content, beanRegistry);
    checkJavaxImports(path, content, issues);
    checkDeprecatedSpringApis(path, content, issues);
    checkEnableWebMvcConflict(path, content, issues);
    checkValueFieldInjection(path, content, issues, fieldInjectionFiles);
    checkJndiReferences(path, content, issues);
    checkMissingConfigAnnotation(path, content, issues);

    if (content.includes("@SpringBootApplication")) {
      hasMainClass = true;
    }
    if (content.includes("@EnableTransactionManagement")) hasTransactionManager = true;
    if (content.includes("SecurityFilterChain") || content.includes("@EnableWebSecurity")) hasSecurityConfig = true;
  }

  const duplicateBeans = checkDuplicateBeans(beanRegistry, issues);

  checkProjectLevelRules(fileMap, issues, hasTransactionManager, hasSecurityConfig);

  if (!hasMainClass) {
    const hasJavaFiles = Array.from(fileMap.keys()).some((p) => p.endsWith(".java"));
    if (hasJavaFiles) {
      issues.push({
        file: "project",
        type: "missing-main",
        message: "No @SpringBootApplication main class found in migrated files",
        severity: "error",
      });
    }
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const passed = errorCount === 0;

  logger.info(
    `Static validation ${passed ? "passed" : "FAILED"}: ` +
    `${issues.length} issues (${errorCount} errors), ` +
    `fieldInj=${fieldInjectionFiles.length}, xmlRefs=${xmlReferenceFiles.length}, ` +
    `dupBeans=${duplicateBeans.length}, hasMain=${hasMainClass}`
  );

  return { passed, issues, fieldInjectionFiles, duplicateBeans, xmlReferenceFiles, hasMainClass };
}

function checkFieldInjection(
  path: string,
  content: string,
  issues: StaticValidationIssue[],
  fieldInjectionFiles: string[]
): void {
  const lines = content.split("\n");
  let pendingAutowired = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.includes("@Autowired") || trimmed.includes("@Inject") || trimmed.includes("@Resource")) {
      pendingAutowired = true;
      continue;
    }

    if (pendingAutowired) {
      const isField = /^(?:private|protected|public)\s+[\w<>[\],\s]+\s+\w+\s*;/.test(trimmed);
      if (isField) {
        issues.push({
          file: path,
          type: "field-injection",
          message: `Field injection detected: "${trimmed.slice(0, 80)}" — convert to constructor injection`,
          severity: "warning",
        });
        if (!fieldInjectionFiles.includes(path)) {
          fieldInjectionFiles.push(path);
        }
      }
      if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        pendingAutowired = false;
      }
    }
  }
}

function checkXmlReferences(
  path: string,
  content: string,
  issues: StaticValidationIssue[],
  xmlReferenceFiles: string[]
): void {
  const xmlPatterns = [
    /ClassPathXmlApplicationContext/,
    /FileSystemXmlApplicationContext/,
    /XmlWebApplicationContext/,
    /\.xml"\s*\)/,
    /applicationContext\.xml/,
    /dispatcher-servlet\.xml/,
    /web\.xml/,
  ];

  for (const pattern of xmlPatterns) {
    if (pattern.test(content)) {
      issues.push({
        file: path,
        type: "xml-reference",
        message: `XML reference found: ${pattern.source} — should be removed in Spring Boot`,
        severity: "warning",
      });
      if (!xmlReferenceFiles.includes(path)) {
        xmlReferenceFiles.push(path);
      }
      break;
    }
  }
}

function checkMainClass(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  if (!content.includes("@SpringBootApplication")) return;

  if (!content.includes("SpringApplication.run(")) {
    issues.push({
      file: path,
      type: "missing-annotation",
      message: "File has @SpringBootApplication but is missing SpringApplication.run() call in main()",
      severity: "error",
    });
  }
}

function collectBeans(
  path: string,
  content: string,
  beanRegistry: Map<string, string[]>
): void {
  const beanMethodPattern = /@Bean\s*\n?\s*(?:public\s+)?(?:\w+\s+)?(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = beanMethodPattern.exec(content)) !== null) {
    const beanName = match[1];
    const existing = beanRegistry.get(beanName) ?? [];
    existing.push(path);
    beanRegistry.set(beanName, existing);
  }

  const stereotypePattern = /@(?:Service|Repository|Component|Controller|RestController)\s*(?:\([^)]*\))?\s*(?:public\s+)?class\s+(\w+)/;
  const classMatch = content.match(stereotypePattern);
  if (classMatch) {
    const beanName = classMatch[1].charAt(0).toLowerCase() + classMatch[1].slice(1);
    const existing = beanRegistry.get(beanName) ?? [];
    existing.push(path);
    beanRegistry.set(beanName, existing);
  }
}

function checkDuplicateBeans(
  beanRegistry: Map<string, string[]>,
  issues: StaticValidationIssue[]
): string[] {
  const duplicates: string[] = [];

  for (const [beanName, files] of beanRegistry) {
    if (files.length > 1) {
      duplicates.push(beanName);
      issues.push({
        file: files.join(", "),
        type: "duplicate-bean",
        message: `Duplicate bean "${beanName}" defined in: ${files.join(", ")}`,
        severity: "error",
      });
    }
  }

  return duplicates;
}

function checkJavaxImports(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  const javaxPatterns = [
    /import\s+javax\.servlet\./,
    /import\s+javax\.persistence\./,
    /import\s+javax\.validation\./,
    /import\s+javax\.transaction\./,
    /import\s+javax\.annotation\.(?!Nullable|Nonnull)/,
  ];
  for (const pattern of javaxPatterns) {
    if (pattern.test(content)) {
      issues.push({
        file: path,
        type: "javax-import",
        message: `Legacy javax.* import detected (${pattern.source}) — migrate to jakarta.* for Spring Boot 3.x compatibility`,
        severity: "warning",
      });
      break;
    }
  }
}

function checkDeprecatedSpringApis(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  const deprecated = [
    { pattern: /XmlBeanFactory/, msg: "XmlBeanFactory is removed in Spring 6 — use AnnotationConfigApplicationContext" },
    { pattern: /SimpleFormController/, msg: "SimpleFormController is removed — use @Controller with @RequestMapping" },
    { pattern: /AbstractFormController/, msg: "AbstractFormController is removed — use @Controller" },
    { pattern: /MultiActionController/, msg: "MultiActionController is removed — use @Controller with @RequestMapping methods" },
    { pattern: /new\s+ClassPathXmlApplicationContext/, msg: "ClassPathXmlApplicationContext should not be used in migrated code — context is managed by Spring Boot" },
    { pattern: /WebMvcConfigurerAdapter/, msg: "WebMvcConfigurerAdapter is deprecated/removed — implement WebMvcConfigurer directly" },
  ];
  for (const { pattern, msg } of deprecated) {
    if (pattern.test(content)) {
      issues.push({
        file: path,
        type: "deprecated-api",
        message: msg,
        severity: "error",
      });
    }
  }
}

function checkEnableWebMvcConflict(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  if (content.includes("@EnableWebMvc") && content.includes("@SpringBootApplication")) {
    issues.push({
      file: path,
      type: "enable-web-mvc-conflict",
      message: "@EnableWebMvc on the @SpringBootApplication class disables Spring Boot MVC auto-configuration — remove @EnableWebMvc or move to a separate @Configuration class",
      severity: "error",
    });
  }
}

function checkValueFieldInjection(
  path: string,
  content: string,
  issues: StaticValidationIssue[],
  fieldInjectionFiles: string[]
): void {
  const lines = content.split("\n");
  let pendingValue = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@Value(")) {
      pendingValue = true;
      continue;
    }
    if (pendingValue) {
      const isField = /^(?:private|protected|public)\s+[\w<>[\],\s]+\s+\w+\s*;/.test(trimmed);
      if (isField) {
        issues.push({
          file: path,
          type: "value-field-injection",
          message: `@Value field injection detected: "${trimmed.slice(0, 80)}" — prefer @ConfigurationProperties for grouped config or constructor injection`,
          severity: "warning",
        });
        if (!fieldInjectionFiles.includes(path)) fieldInjectionFiles.push(path);
      }
      if (trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        pendingValue = false;
      }
    }
  }
}

function checkJndiReferences(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  if (content.includes("InitialContext") || content.includes("jndi:") || content.includes("java:comp/env")) {
    issues.push({
      file: path,
      type: "jndi-reference",
      message: "JNDI lookup detected — replace with Spring Boot application.properties datasource or @Bean configuration",
      severity: "error",
    });
  }
}

function checkMissingConfigAnnotation(
  path: string,
  content: string,
  issues: StaticValidationIssue[]
): void {
  if (content.includes("@Bean") && !content.includes("@Configuration") && !content.includes("@SpringBootApplication")) {
    issues.push({
      file: path,
      type: "missing-config-annotation",
      message: "@Bean method found without @Configuration class annotation — @Bean methods must be inside a @Configuration class",
      severity: "error",
    });
  }
}

function checkProjectLevelRules(
  fileMap: Map<string, string>,
  issues: StaticValidationIssue[],
  hasTransactionManager: boolean,
  hasSecurityConfig: boolean
): void {
  const allContents = Array.from(fileMap.values()).join("\n");

  const hasJpaAnnotations =
    allContents.includes("@Entity") ||
    allContents.includes("@Repository") ||
    allContents.includes("JpaRepository") ||
    allContents.includes("EntityManager");

  if (hasJpaAnnotations && !hasTransactionManager) {
    issues.push({
      file: "project",
      type: "missing-transaction-enable",
      message: "JPA/@Repository usage detected but no @EnableTransactionManagement found — add it to your main @Configuration class",
      severity: "warning",
    });
  }

  const hasSecurityUsage =
    allContents.includes("@PreAuthorize") ||
    allContents.includes("@Secured") ||
    allContents.includes("@RolesAllowed") ||
    allContents.includes("SecurityContext") ||
    allContents.includes("UsernamePasswordAuthenticationToken");

  if (hasSecurityUsage && !hasSecurityConfig) {
    issues.push({
      file: "project",
      type: "missing-security-filter-chain",
      message: "Spring Security annotations/APIs detected but no SecurityFilterChain @Bean or @EnableWebSecurity found",
      severity: "warning",
    });
  }
}

export function serializeStaticValidationResult(result: StaticValidationResult): string {
  const lines: string[] = [];
  lines.push(`Static Validation: ${result.passed ? "PASSED" : "FAILED"}`);
  lines.push(`Total Issues: ${result.issues.length}`);
  lines.push(`Errors: ${result.issues.filter((i) => i.severity === "error").length}`);
  lines.push(`Warnings: ${result.issues.filter((i) => i.severity === "warning").length}`);
  lines.push(`Has Main Class: ${result.hasMainClass}`);
  lines.push(`Field Injection Files: ${result.fieldInjectionFiles.length}`);
  lines.push(`Duplicate Beans: ${result.duplicateBeans.join(", ") || "none"}`);
  lines.push(`XML Reference Files: ${result.xmlReferenceFiles.length}`);

  if (result.issues.length > 0) {
    lines.push("\nIssues:");
    for (const issue of result.issues) {
      lines.push(`  [${issue.severity.toUpperCase()}] ${issue.type}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}
