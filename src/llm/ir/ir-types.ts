export interface IREntity {
  name: string;
  fields: Array<{ name: string; type: string; optional?: boolean }>;
  source: "plan" | "inferred";
}

export interface IRRoute {
  path: string;
  component: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  auth?: boolean;
  source: "plan" | "inferred";
}

export interface IRComponent {
  name: string;
  type: "page" | "layout" | "ui" | "form" | "modal" | "provider";
  props?: Array<{ name: string; type: string; optional?: boolean }>;
  route?: string;
  source: "plan" | "inferred";
}

export interface IRService {
  name: string;
  methods: string[];
  dependencies: string[];
  source: "plan" | "inferred";
}

export interface IRTestTarget {
  sourceFile: string;
  testFile: string;
  framework: string;
  source: "plan" | "inferred";
}

export interface ProjectIR {
  entities: IREntity[];
  routes: IRRoute[];
  components: IRComponent[];
  services: IRService[];
  tests: IRTestTarget[];
  rawSchema: Record<string, unknown> | null;
}

export function emptyIR(): ProjectIR {
  return {
    entities: [],
    routes: [],
    components: [],
    services: [],
    tests: [],
    rawSchema: null,
  };
}
