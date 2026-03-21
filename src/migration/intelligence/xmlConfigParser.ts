import type { FileMap } from "../../llm/constants";

export interface XmlBeanPropertyRef {
  name: string;
  ref: string;
}

export interface XmlBeanConstructorArg {
  index?: number;
  ref?: string;
  value?: string;
  type?: string;
}

export interface XmlBeanDefinition {
  id: string;
  className: string;
  scope?: string;
  propertyRefs: XmlBeanPropertyRef[];
  constructorArgs: XmlBeanConstructorArg[];
  initMethod?: string;
  destroyMethod?: string;
  factoryBean?: string;
  factoryMethod?: string;
  parent?: string;
  lazy?: boolean;
  primary?: boolean;
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

  const selfClosingBeanRe = /<bean\s+([^>]+)\/>/g;
  const openBeanRe = /<bean\s+([^>]*?)>([\s\S]*?)<\/bean>/g;

  function parseAttrs(attrs: string): Partial<XmlBeanDefinition> {
    const idMatch = attrs.match(/(?:^|\s)id=["']([^"']+)["']/);
    const classMatch = attrs.match(/(?:^|\s)class=["']([^"']+)["']/);
    const scopeMatch = attrs.match(/(?:^|\s)scope=["']([^"']+)["']/);
    const initMatch = attrs.match(/(?:^|\s)init-method=["']([^"']+)["']/);
    const destroyMatch = attrs.match(/(?:^|\s)destroy-method=["']([^"']+)["']/);
    const factoryBeanMatch = attrs.match(/(?:^|\s)factory-bean=["']([^"']+)["']/);
    const factoryMethodMatch = attrs.match(/(?:^|\s)factory-method=["']([^"']+)["']/);
    const parentMatch = attrs.match(/(?:^|\s)parent=["']([^"']+)["']/);
    const lazyMatch = attrs.match(/(?:^|\s)lazy-init=["']([^"']+)["']/);
    const primaryMatch = attrs.match(/(?:^|\s)primary=["']([^"']+)["']/);
    return {
      id: idMatch ? idMatch[1] : undefined,
      className: classMatch ? classMatch[1] : undefined,
      scope: scopeMatch ? scopeMatch[1] : "singleton",
      initMethod: initMatch ? initMatch[1] : undefined,
      destroyMethod: destroyMatch ? destroyMatch[1] : undefined,
      factoryBean: factoryBeanMatch ? factoryBeanMatch[1] : undefined,
      factoryMethod: factoryMethodMatch ? factoryMethodMatch[1] : undefined,
      parent: parentMatch ? parentMatch[1] : undefined,
      lazy: lazyMatch ? lazyMatch[1] === "true" : false,
      primary: primaryMatch ? primaryMatch[1] === "true" : false,
    };
  }

  function extractPropertyRefs(body: string): XmlBeanPropertyRef[] {
    const refs: XmlBeanPropertyRef[] = [];
    const propRe = /<property\s+([^>]+?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = propRe.exec(body)) !== null) {
      const attrs = m[1];
      const nameMatch = attrs.match(/name=["']([^"']+)["']/);
      const refMatch = attrs.match(/ref=["']([^"']+)["']/);
      if (nameMatch && refMatch) {
        refs.push({ name: nameMatch[1], ref: refMatch[1] });
      }
    }
    const propBodyRe = /<property\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/property>/g;
    while ((m = propBodyRe.exec(body)) !== null) {
      const propName = m[1];
      const propBody = m[2];
      const innerRefMatch = propBody.match(/<ref\s+bean=["']([^"']+)["']/);
      if (innerRefMatch && !refs.some((r) => r.name === propName)) {
        refs.push({ name: propName, ref: innerRefMatch[1] });
      }
    }
    return refs;
  }

  function extractConstructorArgs(body: string): XmlBeanConstructorArg[] {
    const args: XmlBeanConstructorArg[] = [];
    const argRe = /<constructor-arg\s+([^>]+?)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = argRe.exec(body)) !== null) {
      const attrs = m[1];
      const indexMatch = attrs.match(/index=["']([^"']+)["']/);
      const refMatch = attrs.match(/ref=["']([^"']+)["']/);
      const valueMatch = attrs.match(/value=["']([^"']+)["']/);
      const typeMatch = attrs.match(/type=["']([^"']+)["']/);
      args.push({
        index: indexMatch ? parseInt(indexMatch[1], 10) : undefined,
        ref: refMatch ? refMatch[1] : undefined,
        value: valueMatch ? valueMatch[1] : undefined,
        type: typeMatch ? typeMatch[1] : undefined,
      });
    }
    const argBodyRe = /<constructor-arg(?:\s[^>]*)?>[\s\S]*?<ref\s+bean=["']([^"']+)["']/g;
    while ((m = argBodyRe.exec(body)) !== null) {
      if (!args.some((a) => a.ref === m![1])) {
        args.push({ ref: m[1] });
      }
    }
    return args;
  }

  let m: RegExpExecArray | null;

  selfClosingBeanRe.lastIndex = 0;
  while ((m = selfClosingBeanRe.exec(content)) !== null) {
    const parsed = parseAttrs(m[1]);
    if (parsed.className) {
      beans.push({
        id: parsed.id ?? "anonymous",
        className: parsed.className,
        scope: parsed.scope ?? "singleton",
        propertyRefs: [],
        constructorArgs: [],
        ...parsed,
      });
    }
  }

  openBeanRe.lastIndex = 0;
  while ((m = openBeanRe.exec(content)) !== null) {
    const parsed = parseAttrs(m[1]);
    const body = m[2];
    if (parsed.className || parsed.id) {
      const propertyRefs = extractPropertyRefs(body);
      const constructorArgs = extractConstructorArgs(body);
      beans.push({
        id: parsed.id ?? "anonymous",
        className: parsed.className ?? "(factory)",
        scope: parsed.scope ?? "singleton",
        propertyRefs,
        constructorArgs,
        initMethod: parsed.initMethod,
        destroyMethod: parsed.destroyMethod,
        factoryBean: parsed.factoryBean,
        factoryMethod: parsed.factoryMethod,
        parent: parsed.parent,
        lazy: parsed.lazy,
        primary: parsed.primary,
      });
    }
  }

  const seen = new Set<string>();
  return beans.filter((b) => {
    const key = `${b.id}::${b.className}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
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
    lines.push(`  Beans (${xml.beans.length}):`);
    for (const b of xml.beans.slice(0, 20)) {
      const shortClass = b.className.split(".").pop() ?? b.className;
      const wirings: string[] = [];
      for (const p of b.propertyRefs) {
        wirings.push(`${p.name}→${p.ref}`);
      }
      for (const c of b.constructorArgs) {
        if (c.ref) wirings.push(`ctor→${c.ref}`);
        else if (c.value) wirings.push(`ctor="${c.value}"`);
      }
      const wiringStr = wirings.length > 0 ? ` [wires: ${wirings.join(", ")}]` : "";
      const extras: string[] = [];
      if (b.scope && b.scope !== "singleton") extras.push(`scope=${b.scope}`);
      if (b.initMethod) extras.push(`init=${b.initMethod}`);
      if (b.primary) extras.push("primary");
      if (b.lazy) extras.push("lazy");
      if (b.parent) extras.push(`parent=${b.parent}`);
      const extraStr = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      lines.push(`    • ${b.id}: ${shortClass}${extraStr}${wiringStr}`);
    }
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
