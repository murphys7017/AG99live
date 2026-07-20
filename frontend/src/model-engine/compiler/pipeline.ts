export function runCompilePipeline<
  Context,
  Result extends { ok: boolean },
>(
  context: Context,
  stages: Array<{ id: string; run(context: Context): Result }>,
): Extract<Result, { ok: false }> & { stageId: string } | { ok: true } {
  for (const stage of stages) {
    const result = stage.run(context);
    if (!result.ok) {
      return { ...result, stageId: stage.id } as Extract<Result, { ok: false }> & { stageId: string };
    }
  }
  return { ok: true };
}
