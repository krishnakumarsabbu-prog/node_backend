import type { FileSummary, FileRole } from "./semanticExtractor";

export type EdgeType = "calls" | "injects" | "extends" | "uses" | "imports";

export interface GraphNode {
  id: string;
  type: FileRole;
  filePath: string;
  classNames: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  adjacency: Record<string, string[]>;
  reverseAdjacency: Record<string, string[]>;
}

function normalizeImport(imp: string, fromPath: string): string | null {
  if (imp.startsWith(".")) {
    const dir = fromPath.substring(0, fromPath.lastIndexOf("/"));
    const parts = (dir + "/" + imp).split("/");
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === "..") resolved.pop();
      else if (p !== ".") resolved.push(p);
    }
    return resolved.join("/");
  }
  return null;
}

function classToPath(className: string, allPaths: string[]): string | null {
  const simpleName = className.split(".").pop() || className;
  for (const p of allPaths) {
    const fileName = p.split("/").pop() || "";
    if (fileName === simpleName + ".java" || fileName === simpleName + ".ts" || fileName === simpleName + ".tsx") {
      return p;
    }
  }
  return null;
}

export function buildDependencyGraph(summaries: FileSummary[]): DependencyGraph {
  const nodes: GraphNode[] = summaries.map((s) => ({
    id: s.path,
    type: s.role,
    filePath: s.path,
    classNames: s.classNames,
  }));

  const edges: GraphEdge[] = [];
  const allPaths = summaries.map((s) => s.path);
  const pathSet = new Set(allPaths);

  for (const summary of summaries) {
    for (const imp of summary.imports) {
      const resolved = normalizeImport(imp, summary.path);
      if (resolved) {
        const candidates = [
          resolved,
          resolved + ".ts",
          resolved + ".tsx",
          resolved + ".js",
          resolved + ".java",
        ];
        for (const candidate of candidates) {
          if (pathSet.has(candidate)) {
            edges.push({ from: summary.path, to: candidate, type: "imports" });
            break;
          }
        }
        continue;
      }

      const targetPath = classToPath(imp, allPaths);
      if (targetPath && targetPath !== summary.path) {
        const edgeType: EdgeType = summary.usesAutowired ? "injects" : "uses";
        edges.push({ from: summary.path, to: targetPath, type: edgeType });
      }
    }
  }

  const adjacency: Record<string, string[]> = {};
  const reverseAdjacency: Record<string, string[]> = {};

  for (const node of nodes) {
    adjacency[node.id] = [];
    reverseAdjacency[node.id] = [];
  }

  for (const edge of edges) {
    if (!adjacency[edge.from]) adjacency[edge.from] = [];
    if (!reverseAdjacency[edge.to]) reverseAdjacency[edge.to] = [];
    adjacency[edge.from].push(edge.to);
    reverseAdjacency[edge.to].push(edge.from);
  }

  return { nodes, edges, adjacency, reverseAdjacency };
}

export function getNodesByRole(graph: DependencyGraph, role: FileRole): GraphNode[] {
  return graph.nodes.filter((n) => n.type === role);
}

export function getDependenciesOf(graph: DependencyGraph, filePath: string, depth = 2): string[] {
  const visited = new Set<string>();
  const queue: Array<{ path: string; d: number }> = [{ path: filePath, d: 0 }];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.path)) continue;
    visited.add(item.path);
    if (item.d < depth) {
      for (const dep of graph.adjacency[item.path] || []) {
        if (!visited.has(dep)) {
          queue.push({ path: dep, d: item.d + 1 });
        }
      }
    }
  }

  visited.delete(filePath);
  return Array.from(visited);
}

export function serializeDependencyGraph(graph: DependencyGraph): string {
  const lines: string[] = [];

  const byRole: Partial<Record<FileRole, GraphNode[]>> = {};
  for (const node of graph.nodes) {
    if (!byRole[node.type]) byRole[node.type] = [];
    byRole[node.type]!.push(node);
  }

  const roleOrder: FileRole[] = ["entry", "config", "controller", "service", "repository", "model", "test", "other"];
  for (const role of roleOrder) {
    const roleNodes = byRole[role];
    if (!roleNodes || roleNodes.length === 0) continue;
    lines.push(`${role.toUpperCase()} (${roleNodes.length}):`);
    for (const node of roleNodes) {
      const deps = graph.adjacency[node.id] || [];
      const depStr = deps.length > 0 ? ` → [${deps.map((d) => d.split("/").pop()).join(", ")}]` : "";
      lines.push(`  ${node.filePath}${depStr}`);
    }
  }

  return lines.join("\n");
}
