// Public output is an explicit aggregate allowlist. Never spread private records here.
export function metrics(result) {
  const { exact, solution, heuristics } = result.analysis;
  const actions = solution.actions;
  const turns = actions.slice(1).filter((action, i) => action !== actions[i]).length;
  return { actions: solution.minimumMoves, movementSteps: solution.movementSteps, turns,
    deadEnds: exact.deadEnds, branches: exact.branchCells, branchingFrequency: exact.branchingFrequency,
    cycleRank: exact.geometricCycleRank, shortestSolutions: solution.shortestSolutions,
    fireRequired: exact.fireInteractions, pickupsOnOptimalRoute: exact.pickupInteractions,
    extinguisherReachable: solution.unreachableItems.length === 0, score: heuristics.score,
    heuristicTier: heuristics.estimatedDifficulty };
}
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1),
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3)) };
};
export function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const { width, height } = record.result.config, size = `${width}x${height}`;
    if (!groups.has(size)) groups.set(size, []);
    groups.get(size).push(record);
  }
  const summarizeGroup = rows => {
    const trials = rows.flatMap(r => r.trials), reasons = {};
    for (const trial of trials) {
      for (const attempt of trial.attempts) if (attempt.code !== 'ACCEPTED') reasons[attempt.code] = (reasons[attempt.code] ?? 0) + 1;
    }
    const result = { accepted: rows.length, seedTrials: trials.length,
      exhaustedSeeds: trials.filter(t => t.status === 'GENERATION_EXHAUSTED').length,
      qualityRejectedSeeds: trials.filter(t => t.status === 'QUALITY_REJECTED').length,
      rejectedCandidates: Object.values(reasons).reduce((a, b) => a + b, 0), rejectionReasons: reasons,
      solvabilityFailures: rows.filter(r => !r.result.analysis.solution.solvable).length,
      requiredFireCount: rows.filter(r => r.metrics.fireRequired > 0).length,
      reachableExtinguisherCount: rows.filter(r => r.metrics.extinguisherReachable).length,
      heuristicTiers: Object.fromEntries(['easy', 'medium', 'hard'].map(t => [t, rows.filter(r => r.metrics.heuristicTier === t).length])),
      plannedTiers: Object.fromEntries([...new Set(rows.map(r => r.tier))].map(t => [t, rows.filter(r => r.tier === t).length])),
      fireTilesPerMaze: 1, extinguisherTilesPerMaze: 1 };
    for (const key of ['actions', 'movementSteps', 'turns', 'deadEnds', 'branches', 'branchingFrequency', 'cycleRank', 'shortestSolutions', 'score']) {
      result[key] = distribution(rows.map(r => r.metrics[key]));
    }
    result.generationMs = distribution(trials.map(t => t.durationMs));
    result.playtestCriteriaCounts = {
      actionsOver120: rows.filter(r => r.metrics.actions > 120).length,
      actionsUnder25: rows.filter(r => r.metrics.actions < 25).length,
      turnsOver60: rows.filter(r => r.metrics.turns > 60).length,
      optionalFire: rows.filter(r => r.metrics.fireRequired === 0).length,
    };
    return result;
  };
  return { schemaVersion: 1, mode: 'sanitized-aggregate-only', total: summarizeGroup(records),
    sizes: Object.fromEntries([...groups].map(([size, rows]) => [size, summarizeGroup(rows)])) };
}
