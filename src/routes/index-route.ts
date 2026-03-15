import { Request, Response } from 'express';
import {
  buildIndexAsync,
  getIndex,
  invalidateIndex,
  search,
  searchWithGraph,
  searchWithEmbedding,
} from '../modules/ai_engine/agent.js';

let indexedRepoPath: string | null = null;

export async function indexBuildHandler(req: Request, res: Response): Promise<void> {
  const { path: repoPath } = req.body as { path?: string };

  if (!repoPath || typeof repoPath !== 'string' || repoPath.trim() === '') {
    res.status(400).json({ error: true, message: '`path` (string) is required in the request body' });
    return;
  }

  try {
    const index = await buildIndexAsync(repoPath.trim());
    indexedRepoPath = repoPath.trim();

    res.json({
      indexed: true,
      path: indexedRepoPath,
      stats: {
        totalFiles: index.statistics.totalFiles,
        totalLines: index.statistics.totalLines,
        symbolCount: index.statistics.symbolCount,
        edges: index.graph.edges.length,
        languageDistribution: index.statistics.languageDistribution,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: true, message: err?.message ?? 'Failed to build index' });
  }
}

export function indexStatusHandler(_req: Request, res: Response): void {
  const index = getIndex();

  if (!index) {
    res.json({ indexed: false, path: null, stats: null });
    return;
  }

  res.json({
    indexed: true,
    path: indexedRepoPath,
    stats: {
      totalFiles: index.statistics.totalFiles,
      totalLines: index.statistics.totalLines,
      symbolCount: index.statistics.symbolCount,
      edges: index.graph.edges.length,
      languageDistribution: index.statistics.languageDistribution,
    },
  });
}

export function indexSearchHandler(req: Request, res: Response): void {
  const { query, topK = 10, graphDepth = 1, mode = 'graph' } = req.body as {
    query?: string;
    topK?: number;
    graphDepth?: number;
    mode?: 'basic' | 'graph' | 'embedding';
  };

  if (!query || typeof query !== 'string' || query.trim() === '') {
    res.status(400).json({ error: true, message: '`query` (string) is required in the request body' });
    return;
  }

  const index = getIndex();
  if (!index) {
    res.status(400).json({ error: true, message: 'No index available. POST /api/index first.' });
    return;
  }

  try {
    let files: string[] | { file: { path: string }; score: number }[];

    if (mode === 'basic') {
      const results = search(query, Number(topK));
      files = results.map(r => r.file.path);
    } else if (mode === 'embedding') {
      files = searchWithEmbedding(query, Number(topK), Number(graphDepth));
    } else {
      files = searchWithGraph(query, Number(topK), Number(graphDepth));
    }

    res.json({ query, mode, files });
  } catch (err: any) {
    res.status(500).json({ error: true, message: err?.message ?? 'Search failed' });
  }
}

export function indexInvalidateHandler(_req: Request, res: Response): void {
  invalidateIndex();
  indexedRepoPath = null;
  res.json({ invalidated: true });
}
