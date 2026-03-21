import type { MigrationTask, MigrationTaskCategory } from "../types/migrationTypes";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("task-graph");

export interface TaskNode {
  task: MigrationTask;
  dependents: string[];
  inDegree: number;
}

export interface ExecutionWave {
  wave: number;
  tasks: MigrationTask[];
  canParallelize: boolean;
}

export interface TaskGraph {
  nodes: Map<string, TaskNode>;
  executionWaves: ExecutionWave[];
  stageOrder: MigrationTaskCategory[];
}

const STAGE_ORDER: MigrationTaskCategory[] = ["build", "config", "code", "resource"];
const STAGE_PRIORITY: Record<MigrationTaskCategory, number> = {
  build: 0,
  config: 1,
  code: 2,
  resource: 3,
};

const SPRING_TASK_SUB_PRIORITY: Array<{ pattern: RegExp; priority: number }> = [
  { pattern: /Application\.(java|kt)$/i, priority: 100 },
  { pattern: /pom\.xml$/i, priority: 99 },
  { pattern: /build\.gradle(\.kts)?$/i, priority: 99 },
  { pattern: /SecurityConfig/i, priority: 80 },
  { pattern: /WebConfig|WebMvcConfig/i, priority: 75 },
  { pattern: /AppConfig|ApplicationConfig/i, priority: 70 },
  { pattern: /DataSourceConfig|JpaConfig|PersistenceConfig/i, priority: 65 },
  { pattern: /FilterRegistration|FilterConfig/i, priority: 60 },
  { pattern: /InterceptorConfig/i, priority: 55 },
  { pattern: /AopConfig|AspectConfig/i, priority: 50 },
  { pattern: /SchedulingConfig|AsyncConfig/i, priority: 45 },
  { pattern: /application\.(properties|yml|yaml)$/i, priority: 40 },
];

function getSpringSubPriority(file: string): number {
  const name = file.split("/").pop() ?? file;
  for (const { pattern, priority } of SPRING_TASK_SUB_PRIORITY) {
    if (pattern.test(name) || pattern.test(file)) return priority;
  }
  return 0;
}

export function buildTaskGraph(tasks: MigrationTask[]): TaskGraph {
  const nodes = new Map<string, TaskNode>();

  for (const task of tasks) {
    nodes.set(task.id, {
      task,
      dependents: [],
      inDegree: 0,
    });
  }

  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      const depNode = nodes.get(depId);
      if (depNode) {
        depNode.dependents.push(task.id);
        nodes.get(task.id)!.inDegree++;
      } else {
        logger.warn(`Task ${task.id} has unknown dependency: ${depId} — ignoring`);
      }
    }
  }

  const executionWaves = topoSortIntoWaves(nodes);

  logger.info(
    `Task graph built: ${nodes.size} tasks, ${executionWaves.length} execution waves`
  );

  return { nodes, executionWaves, stageOrder: STAGE_ORDER };
}

function topoSortIntoWaves(nodes: Map<string, TaskNode>): ExecutionWave[] {
  const inDegree = new Map<string, number>();
  for (const [id, node] of nodes) {
    inDegree.set(id, node.inDegree);
  }

  const waves: ExecutionWave[] = [];
  let waveIndex = 0;

  while (inDegree.size > 0) {
    const ready = Array.from(inDegree.entries())
      .filter(([, deg]) => deg === 0)
      .map(([id]) => id);

    if (ready.length === 0) {
      logger.warn("Cycle detected in task graph — forcing remaining tasks into final wave");
      const remaining = Array.from(inDegree.keys())
        .map((id) => nodes.get(id)!.task)
        .sort(byStageAndPriority);
      waves.push({ wave: waveIndex, tasks: remaining, canParallelize: false });
      break;
    }

    const waveTasks = ready
      .map((id) => nodes.get(id)!.task)
      .sort(byStageAndPriority);

    waves.push({
      wave: waveIndex++,
      tasks: waveTasks,
      canParallelize: waveTasks.length > 1,
    });

    for (const id of ready) {
      inDegree.delete(id);
      for (const dependentId of nodes.get(id)!.dependents) {
        const current = inDegree.get(dependentId) ?? 0;
        inDegree.set(dependentId, current - 1);
      }
    }
  }

  return waves;
}

function byStageAndPriority(a: MigrationTask, b: MigrationTask): number {
  const stageA = STAGE_PRIORITY[a.type ?? "code"];
  const stageB = STAGE_PRIORITY[b.type ?? "code"];
  if (stageA !== stageB) return stageA - stageB;

  const subA = getSpringSubPriority(a.file);
  const subB = getSpringSubPriority(b.file);
  if (subA !== subB) return subB - subA;

  return (b.priority ?? 5) - (a.priority ?? 5);
}

export function groupTasksByStage(
  tasks: MigrationTask[]
): Map<MigrationTaskCategory, MigrationTask[]> {
  const groups = new Map<MigrationTaskCategory, MigrationTask[]>();
  for (const stage of STAGE_ORDER) {
    groups.set(stage, []);
  }
  for (const task of tasks) {
    const stage = task.type ?? "code";
    groups.get(stage)!.push(task);
  }
  return groups;
}
