import type { CompileDiagnostics, CompileOptions } from "./contracts.js";
import type { MotionCompileContext } from "./compileContext.js";
import type { ModelEngineSettings } from "../settings.js";

export function buildBaseCompileDiagnostics(
  options: CompileOptions,
  settings: ModelEngineSettings,
): CompileDiagnostics {
  return {
    usedActionLibrary: false,
    compiledParameterCount: 0,
    timingSource: "default",
    resolvedMode: "idle",
    speechActive: options.speechActive === true,
    source: options.source,
    intensityApplied: false,
    motionIntensityScale: settings.motionIntensityScale,
    axisIntensityScale: { ...settings.axisIntensityScale },
    warnings: [],
  };
}

export function finalizeCompileDiagnostics(
  context: MotionCompileContext,
  extra: Partial<CompileDiagnostics> = {},
): CompileDiagnostics {
  const { baseDiagnostics, state } = context;
  const compiledParameters = state.parameters.map((item) => item.parameter_id);
  const appliedDerivedAxes = [...state.appliedDerivedAxes];

  return {
    ...baseDiagnostics,
    timingSource: state.timing?.timingSource ?? baseDiagnostics.timingSource,
    resolvedMode: state.resolvedMode,
    compiledParameterCount: state.parameters.length,
    warnings: [...state.warnings],
    primaryAxes: [...state.roleAxisIds.primaryAxes],
    hintAxes: [...state.roleAxisIds.hintAxes],
    derivedAxes: appliedDerivedAxes,
    availableDerivedAxes: [...state.roleAxisIds.derivedAxes],
    appliedDerivedAxes,
    runtimeAxes: [...state.roleAxisIds.runtimeAxes],
    missingAxes: [...state.missingAxes],
    forbiddenAxes: [...state.forbiddenAxes],
    invalidAxes: [...state.invalidAxes],
    axisErrorCount: state.axisErrorCount,
    axisErrorLimit: state.axisErrorLimit,
    compiledParameters,
    ...extra,
  };
}
