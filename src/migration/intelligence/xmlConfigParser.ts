import type { FileMap } from "../../llm/constants";

export interface XmlBeanDefinition {
  id: string;
  className: string;
  scope?: string;
}

export interface XmlFileSummary {
  file: string;
  xmlType: "web-xml" | "application-context" | "dispatcher-servlet" | "security" | "persistence" | "generic";
  beanCount: number;
  componentScan: boolean;
  dispatcherServlet: boolean;
  viewResolver: boolean;
  securityConfig: boolean;
  dataSource: boolean;
  transactionManager: boolean;
  propertyPlaceholder: boolean;
  beans: XmlBeanDefinition[];
  servletMappings: string[];
  contextParams: Record<string, string>;
  rawSnippet: string;
}

function detectXmlType(filename: string, content: string): XmlFileSummary["xmlType"] {
  const name = filename.toLowerCase();
  if (name.endsWith("web.xml")) return "web-xml";
  if (name.includes("dispatcher") || name.includes("servlet")) return "dispatcher-servlet";
  if (name.includes("security")) return "security";
  if (name.includes("persistence") || name.includes("hibernate")) return "persistence";
  if (name.includes("applicationcontext") || name.includes("application-context")) return "application-context";
  if (content.includes("<web-app") || content.includes("DispatcherServlet")) return "web-xml";
  if (content.includes("dispatcher-servlet") || content.includes("mvc:annotation-driven")) return "dispatcher-servlet";
  return "generic";
}

function extractBeans(content: string): XmlBeanDefinition[] {
  const beans: XmlBeanDefinition[] = [];
  const beanRe = /<bean\s+([^>]+)>/g;
  let m: RegExpExecArray | null;

  while ((m = beanRe.exec(content)) !== null) {
    const attrs = m[1];
    const idMatch = attrs.match(/id=["']([^"']+)["']/);
    const classMatch = attrs.match(/class=["']([^"']+)["']/);
    const scopeMatch = attrs.match(/scope=["']([^"']+)["']/);

    if (classMatch) {
      beans.push({
        id: idMatch ? idMatch[1] : "anonymous",
        className: classMatch[1],
        scope: scopeMatch ? scopeMatch[1] : "singleton",
      });
    }
  }

  return beans.slice(0, 20);
}

function extractServletMappings(content: string): string[] {
  const mappings: string[] = [];
  const re = /<url-pattern>([^<]+)<\/url-pattern>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    mappings.push(m[1].trim());
  }
  return mappings;
}

function extractContextParams(content: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /<context-param>[\s\S]*?<param-name>([^<]+)<\/param-name>[\s\S]*?<param-value>([^<]+)<\/param-value>[\s\S]*?<\/context-param>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    params[m[1].trim()] = m[2].trim();
  }
  return params;
}

function extractPropertyPlaceholders(content: string): boolean {
  return content.includes("PropertyPlaceholderConfigurer") ||
    content.includes("context:property-placeholder") ||
    content.includes("PropertySourcesPlaceholderConfigurer");
}

export function parseXmlConfigs(files: FileMap): XmlFileSummary[] {
  const summaries: XmlFileSummary[] = [];

  for (const [path, entry] of Object.entries(files)) {
    if (!entry || entry.type !== "file" || entry.isBinary) continue;
    if (!path.endsWith(".xml") || path.endsWith("pom.xml")) continue;

    const content = (entry as any).content as string;
    if (!content || typeof content !== "string") continue;

    const xmlType = detectXmlType(path, content);
    const beans = extractBeans(content);
    const servletMappings = extractServletMappings(content);
    const contextParams = extractContextParams(content);

    summaries.push({
      file: path,
      xmlType,
      beanCount: beans.length,
      componentScan: content.includes("context:component-scan") || content.includes("ComponentScan"),
      dispatcherServlet: content.includes("DispatcherServlet") || content.includes("dispatcher-servlet"),
      viewResolver: content.includes("ViewResolver") || content.includes("InternalResourceViewResolver"),
      securityConfig: content.includes("security:") || content.includes("http-security") || content.includes("AuthenticationManager"),
      dataSource: content.includes("DataSource") || content.includes("dataSource") || content.includes("jdbc:"),
      transactionManager: content.includes("TransactionManager") || content.includes("transactionManager"),
      propertyPlaceholder: extractPropertyPlaceholders(content),
      beans,
      servletMappings,
      contextParams,
      rawSnippet: content.slice(0, 600),
    });
  }

  return summaries;
}

export function serializeXmlSummary(xml: XmlFileSummary): string {
  const lines: string[] = [`[XML:${xml.xmlType.toUpperCase()}] ${xml.file}`];
  lines.push(`  Beans: ${xml.beanCount}`);

  const flags: string[] = [];
  if (xml.componentScan) flags.push("component-scan");
  if (xml.dispatcherServlet) flags.push("DispatcherServlet");
  if (xml.viewResolver) flags.push("ViewResolver");
  if (xml.securityConfig) flags.push("Security");
  if (xml.dataSource) flags.push("DataSource");
  if (xml.transactionManager) flags.push("TransactionManager");
  if (xml.propertyPlaceholder) flags.push("PropertyPlaceholder");
  if (flags.length > 0) lines.push(`  Features: ${flags.join(", ")}`);

  if (xml.beans.length > 0) {
    const beanStr = xml.beans.slice(0, 8).map((b) => `${b.id}(${b.className.split(".").pop()})`).join(", ");
    lines.push(`  Key Beans: ${beanStr}`);
  }

  if (xml.servletMappings.length > 0) {
    lines.push(`  Servlet Mappings: ${xml.servletMappings.join(", ")}`);
  }

  const transformHint = getTransformHint(xml);
  if (transformHint) lines.push(`  Boot Replacement: ${transformHint}`);

  return lines.join("\n");
}

function getTransformHint(xml: XmlFileSummary): string {
  switch (xml.xmlType) {
    case "web-xml":
      return "@SpringBootApplication main class + embedded Tomcat (remove web.xml)";
    case "dispatcher-servlet":
      return "@Configuration with @EnableWebMvc or Spring Boot auto-config (remove dispatcher-servlet.xml)";
    case "application-context":
      return "@Configuration class(es) with @Bean methods (remove applicationContext.xml)";
    case "security":
      return "SecurityFilterChain @Bean in @Configuration (remove security XML)";
    case "persistence":
      return "application.properties datasource config + @EnableTransactionManagement";
    default:
      if (xml.dataSource) return "application.properties spring.datasource.* properties";
      if (xml.viewResolver) return "Spring Boot auto-configured InternalResourceViewResolver";
      return "@Configuration class with equivalent @Bean definitions";
  }
}

export function serializeAllXmlSummaries(summaries: XmlFileSummary[]): string {
  if (summaries.length === 0) return "(no XML configuration files found)";
  return summaries.map(serializeXmlSummary).join("\n\n");
}
