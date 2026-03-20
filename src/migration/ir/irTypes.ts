export type ComponentRole =
  | "controller"
  | "service"
  | "repository"
  | "config"
  | "model"
  | "entry"
  | "test"
  | "resource"
  | "build"
  | "other";

export type InjectionStyle = "constructor" | "field" | "setter" | "none";

export type HttpVerb = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ANY";

export interface IrEndpoint {
  method: HttpVerb;
  path: string;
  handlerName: string;
}

export interface IrField {
  name: string;
  type: string;
  injected: boolean;
  injectionStyle: InjectionStyle;
}

export interface IrMethod {
  name: string;
  returnType: string;
  paramTypes: string[];
  isPublic: boolean;
}

export interface IrComponent {
  id: string;
  role: ComponentRole;
  sourceFile: string;
  className: string;
  packagePath: string;
  annotations: string[];
  imports: string[];
  fields: IrField[];
  methods: IrMethod[];
  endpoints: IrEndpoint[];
  injectionStyle: InjectionStyle;
  dependsOn: string[];
  isEntryPoint: boolean;
  isXmlDefined: boolean;
}

export interface IrBeanDefinition {
  beanName: string;
  beanClass: string;
  scope: "singleton" | "prototype" | "request" | "session" | "other";
  sourceFile: string;
  isXmlDefined: boolean;
  properties: Record<string, string>;
}

export interface IrRoute {
  method: HttpVerb;
  path: string;
  handlerClass: string;
  handlerMethod: string;
  sourceFile: string;
}

export interface IrDependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope: "compile" | "test" | "provided" | "runtime" | "other";
  category: string;
}

export interface IrBuildConfig {
  buildTool: string;
  groupId: string;
  artifactId: string;
  version: string;
  hasBootParent: boolean;
  hasBootPlugin: boolean;
  dependencies: IrDependency[];
  pluginIds: string[];
}

export interface IrProperty {
  key: string;
  value: string;
  sourceFile: string;
}

export interface IrXmlConfig {
  sourceFile: string;
  xmlType: string;
  beanCount: number;
  servletMappings: string[];
  componentScanPackages: string[];
  featureFlags: {
    hasDataSource: boolean;
    hasTransactionManager: boolean;
    hasSecurity: boolean;
    hasViewResolver: boolean;
  };
}

export interface IrProjectModel {
  framework: string;
  buildTool: string;
  components: IrComponent[];
  beans: IrBeanDefinition[];
  routes: IrRoute[];
  buildConfig: IrBuildConfig;
  properties: IrProperty[];
  xmlConfigs: IrXmlConfig[];
  requiredTransformations: IrTransformation[];
  stats: {
    totalComponents: number;
    controllers: number;
    services: number;
    repositories: number;
    xmlDefinedBeans: number;
    fieldInjectionCount: number;
    constructorInjectionCount: number;
    hasBootMain: boolean;
    hasWebXml: boolean;
  };
}

export type IrTransformationType =
  | "xml-to-annotation-config"
  | "field-to-constructor-injection"
  | "add-spring-boot-main"
  | "remove-web-xml"
  | "update-build-parent"
  | "add-boot-plugin"
  | "convert-xml-beans"
  | "add-application-properties"
  | "convert-security-config"
  | "convert-persistence-config"
  | "add-starter-web"
  | "add-starter-data-jpa";

export interface IrTransformation {
  type: IrTransformationType;
  affectedFiles: string[];
  description: string;
  priority: number;
}
