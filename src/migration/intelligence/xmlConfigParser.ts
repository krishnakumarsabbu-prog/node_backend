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

export interface ServletDefinition {
  servletName: string;
  servletClass: string;
  urlPatterns: string[];
  loadOnStartup?: number;
  initParams: Record<string, string>;
  asyncSupported?: boolean;
}

export interface FilterDefinition {
  filterName: string;
  filterClass: string;
  urlPatterns: string[];
  dispatcherTypes: string[];
  initParams: Record<string, string>;
}

export interface ListenerDefinition {
  listenerClass: string;
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
  hasInterceptors: boolean;
  hasCorsConfig: boolean;
  hasAopConfig: boolean;
  hasScheduling: boolean;
  hasAsyncConfig: boolean;
  hasMvcNamespace: boolean;
  beans: XmlBeanDefinition[];
  servletMappings: string[];
  servletDefinitions: ServletDefinition[];
  filterDefinitions: FilterDefinition[];
  listenerDefinitions: ListenerDefinition[];
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

function extractInitParams(block: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /<init-param>[\s\S]*?<param-name>([^<]+)<\/param-name>[\s\S]*?<param-value>([^<]+)<\/param-value>[\s\S]*?<\/init-param>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    params[m[1].trim()] = m[2].trim();
  }
  return params;
}

function extractServletDefinitions(content: string): ServletDefinition[] {
  const servlets: ServletDefinition[] = [];
  const servletDefRe = /<servlet>([\s\S]*?)<\/servlet>/g;
  const servletMapRe = /<servlet-mapping>([\s\S]*?)<\/servlet-mapping>/g;

  const nameToServlet = new Map<string, Partial<ServletDefinition>>();

  let m: RegExpExecArray | null;
  while ((m = servletDefRe.exec(content)) !== null) {
    const block = m[1];
    const nameMatch = block.match(/<servlet-name>([^<]+)<\/servlet-name>/);
    const classMatch = block.match(/<servlet-class>([^<]+)<\/servlet-class>/);
    const loadMatch = block.match(/<load-on-startup>([^<]+)<\/load-on-startup>/);
    const asyncMatch = block.match(/<async-supported>([^<]+)<\/async-supported>/);
    if (nameMatch) {
      nameToServlet.set(nameMatch[1].trim(), {
        servletName: nameMatch[1].trim(),
        servletClass: classMatch ? classMatch[1].trim() : "unknown",
        loadOnStartup: loadMatch ? parseInt(loadMatch[1].trim(), 10) : undefined,
        asyncSupported: asyncMatch ? asyncMatch[1].trim() === "true" : undefined,
        initParams: extractInitParams(block),
        urlPatterns: [],
      });
    }
  }

  while ((m = servletMapRe.exec(content)) !== null) {
    const block = m[1];
    const nameMatch = block.match(/<servlet-name>([^<]+)<\/servlet-name>/);
    if (!nameMatch) continue;
    const servletName = nameMatch[1].trim();
    const servlet = nameToServlet.get(servletName);
    if (servlet) {
      const urlRe = /<url-pattern>([^<]+)<\/url-pattern>/g;
      let um: RegExpExecArray | null;
      while ((um = urlRe.exec(block)) !== null) {
        (servlet.urlPatterns = servlet.urlPatterns ?? []).push(um[1].trim());
      }
    }
  }

  for (const servlet of nameToServlet.values()) {
    if (servlet.servletName && servlet.servletClass) {
      servlets.push(servlet as ServletDefinition);
    }
  }
  return servlets;
}

function extractFilterDefinitions(content: string): FilterDefinition[] {
  const filters: FilterDefinition[] = [];
  const filterDefRe = /<filter>([\s\S]*?)<\/filter>/g;
  const filterMapRe = /<filter-mapping>([\s\S]*?)<\/filter-mapping>/g;

  const nameToFilter = new Map<string, Partial<FilterDefinition>>();

  let m: RegExpExecArray | null;
  while ((m = filterDefRe.exec(content)) !== null) {
    const block = m[1];
    const nameMatch = block.match(/<filter-name>([^<]+)<\/filter-name>/);
    const classMatch = block.match(/<filter-class>([^<]+)<\/filter-class>/);
    if (nameMatch) {
      nameToFilter.set(nameMatch[1].trim(), {
        filterName: nameMatch[1].trim(),
        filterClass: classMatch ? classMatch[1].trim() : "unknown",
        initParams: extractInitParams(block),
        urlPatterns: [],
        dispatcherTypes: [],
      });
    }
  }

  while ((m = filterMapRe.exec(content)) !== null) {
    const block = m[1];
    const nameMatch = block.match(/<filter-name>([^<]+)<\/filter-name>/);
    if (!nameMatch) continue;
    const filter = nameToFilter.get(nameMatch[1].trim());
    if (filter) {
      const urlRe = /<url-pattern>([^<]+)<\/url-pattern>/g;
      const dispRe = /<dispatcher>([^<]+)<\/dispatcher>/g;
      let um: RegExpExecArray | null;
      while ((um = urlRe.exec(block)) !== null) {
        (filter.urlPatterns = filter.urlPatterns ?? []).push(um[1].trim());
      }
      while ((um = dispRe.exec(block)) !== null) {
        (filter.dispatcherTypes = filter.dispatcherTypes ?? []).push(um[1].trim());
      }
    }
  }

  for (const filter of nameToFilter.values()) {
    if (filter.filterName && filter.filterClass) {
      filters.push(filter as FilterDefinition);
    }
  }
  return filters;
}

function extractListenerDefinitions(content: string): ListenerDefinition[] {
  const listeners: ListenerDefinition[] = [];
  const re = /<listener>[\s\S]*?<listener-class>([^<]+)<\/listener-class>[\s\S]*?<\/listener>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    listeners.push({ listenerClass: m[1].trim() });
  }
  return listeners;
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
    const servletDefinitions = extractServletDefinitions(content);
    const filterDefinitions = extractFilterDefinitions(content);
    const listenerDefinitions = extractListenerDefinitions(content);

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
      hasInterceptors: content.includes("<mvc:interceptors") || content.includes("HandlerInterceptor") || content.includes("mvc:interceptor"),
      hasCorsConfig: content.includes("<mvc:cors") || content.includes("CorsFilter") || content.includes("cors-configuration"),
      hasAopConfig: content.includes("<aop:config") || content.includes("<aop:aspectj-autoproxy") || content.includes("EnableAspectJAutoProxy"),
      hasScheduling: content.includes("<task:annotation-driven") || content.includes("TaskScheduler") || content.includes("EnableScheduling"),
      hasAsyncConfig: content.includes("<task:executor") || content.includes("EnableAsync") || content.includes("AsyncConfigurer"),
      hasMvcNamespace: content.includes("mvc:annotation-driven") || content.includes("xmlns:mvc="),
      beans,
      servletMappings,
      servletDefinitions,
      filterDefinitions,
      listenerDefinitions,
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

  if (xml.servletDefinitions.length > 0) {
    lines.push(`  Servlets (${xml.servletDefinitions.length}):`);
    for (const s of xml.servletDefinitions) {
      const patterns = s.urlPatterns.length > 0 ? ` → [${s.urlPatterns.join(", ")}]` : "";
      const initP = Object.keys(s.initParams).length > 0 ? ` initParams={${Object.entries(s.initParams).map(([k, v]) => `${k}:${v}`).join(", ")}}` : "";
      lines.push(`    • ${s.servletName}: ${s.servletClass}${patterns}${initP}${s.loadOnStartup != null ? ` loadOnStartup=${s.loadOnStartup}` : ""}`);
    }
  } else if (xml.servletMappings.length > 0) {
    lines.push(`  Servlet Mappings: ${xml.servletMappings.join(", ")}`);
  }

  if (xml.filterDefinitions.length > 0) {
    lines.push(`  Filters (${xml.filterDefinitions.length}):`);
    for (const f of xml.filterDefinitions) {
      const patterns = f.urlPatterns.length > 0 ? ` → [${f.urlPatterns.join(", ")}]` : "";
      lines.push(`    • ${f.filterName}: ${f.filterClass}${patterns}`);
    }
  }

  if (xml.listenerDefinitions.length > 0) {
    lines.push(`  Listeners: ${xml.listenerDefinitions.map((l) => l.listenerClass.split(".").pop()).join(", ")}`);
  }

  const advancedFlags: string[] = [];
  if (xml.hasInterceptors) advancedFlags.push("interceptors");
  if (xml.hasCorsConfig) advancedFlags.push("CORS");
  if (xml.hasAopConfig) advancedFlags.push("AOP");
  if (xml.hasScheduling) advancedFlags.push("scheduling");
  if (xml.hasAsyncConfig) advancedFlags.push("async");
  if (xml.hasMvcNamespace) advancedFlags.push("mvc-namespace");
  if (advancedFlags.length > 0) lines.push(`  Advanced: ${advancedFlags.join(", ")}`);

  const transformHint = getTransformHint(xml);
  if (transformHint) lines.push(`  Boot Replacement: ${transformHint}`);

  return lines.join("\n");
}

function getTransformHint(xml: XmlFileSummary): string {
  const extras: string[] = [];
  if (xml.filterDefinitions.length > 0) {
    const securityFilters = xml.filterDefinitions.filter((f) =>
      f.filterClass.toLowerCase().includes("security") ||
      f.filterClass.toLowerCase().includes("delegating") ||
      f.filterClass.toLowerCase().includes("spring")
    );
    if (securityFilters.length > 0) extras.push("migrate filters to SecurityFilterChain @Bean");
    else extras.push(`register ${xml.filterDefinitions.length} filter(s) as @Bean with FilterRegistrationBean`);
  }
  if (xml.hasInterceptors) extras.push("register interceptors via WebMvcConfigurer.addInterceptors()");
  if (xml.hasCorsConfig) extras.push("configure CORS via WebMvcConfigurer.addCorsMappings() or @CrossOrigin");
  if (xml.hasAopConfig) extras.push("enable AOP via @EnableAspectJAutoProxy");
  if (xml.hasScheduling) extras.push("enable scheduling via @EnableScheduling");
  if (xml.hasAsyncConfig) extras.push("enable async via @EnableAsync + ThreadPoolTaskExecutor @Bean");
  if (xml.listenerDefinitions.length > 0) extras.push("replace ContextLoaderListener with @SpringBootApplication");

  switch (xml.xmlType) {
    case "web-xml": {
      const base = "@SpringBootApplication main class + embedded Tomcat (remove web.xml)";
      return extras.length > 0 ? `${base}; also: ${extras.join("; ")}` : base;
    }
    case "dispatcher-servlet": {
      const base = xml.hasMvcNamespace
        ? "@EnableWebMvc @Configuration or Spring Boot auto-config (remove dispatcher-servlet.xml)"
        : "@Configuration with @Bean methods (remove dispatcher-servlet.xml)";
      return extras.length > 0 ? `${base}; also: ${extras.join("; ")}` : base;
    }
    case "application-context": {
      const base = "@Configuration class(es) with @Bean methods (remove applicationContext.xml)";
      return extras.length > 0 ? `${base}; also: ${extras.join("; ")}` : base;
    }
    case "security":
      return "SecurityFilterChain @Bean in @Configuration (remove security XML)";
    case "persistence":
      return "application.properties datasource config + @EnableJpaRepositories + @EnableTransactionManagement";
    default:
      if (xml.dataSource) return "application.properties spring.datasource.* properties";
      if (xml.viewResolver) return "Spring Boot auto-configured view resolver or Thymeleaf starter";
      return "@Configuration class with equivalent @Bean definitions";
  }
}

export function serializeAllXmlSummaries(summaries: XmlFileSummary[]): string {
  if (summaries.length === 0) return "(no XML configuration files found)";
  return summaries.map(serializeXmlSummary).join("\n\n");
}
