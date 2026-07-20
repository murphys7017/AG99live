export function runCompilePipeline<
  Context,
  Result extends { ok: boolean },
>(
  context: Context,
  stages: Array<{ run(context: Context): Result }>,
): Result | { ok: true } {
  for (const stage of stages) {
    const result = stage.run(context);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}
