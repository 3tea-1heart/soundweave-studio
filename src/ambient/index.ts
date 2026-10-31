/**
 * Generative Ambient 子系统公共导出。
 */
export { generateAmbient, generateAmbientPiece } from './generate';
export type { GenerateOptions, GenerationStats, GenerateResult } from './generate';
export { renderAmbient, renderAmbientWav } from './render';
export type { AmbientRenderOptions, AmbientRenderResult } from './render';
export { synthesizeTextureAsset, textureLoopSec, TEXTURE_SAMPLE_RATE } from './texture';
export type { TextureSynthOptions } from './texture';
export { analyzeReference, downmix, pitchStabilityFromChroma, estimateTonalCenter } from './analysis';
export type { MicroProfile, MesoProfile, MacroProfile, ReferenceProfile } from './analysis';
export { aggregateReferences, aggregatedToPreset, referencesToPreset } from './reference';
export type { AggregatedProfile, PresetFromProfileOptions } from './reference';
export { fitPreset, mutatePreset, profileDistance } from './fitting';
export type { FitOptions, FitElite, FitResult } from './fitting';
export { createRadioSession, radioAdvance, radioCaptureLast, radioExportState, radioImportState } from './radio';
export type { RadioOptions, RadioSession, RadioState, RadioAgentState } from './radio';
export { emptyPreference, recordPreference, applyPreference, pairForComparison, preferenceFeaturesFromProfile, preferenceFeaturesFromPreset } from './preference';
export type { PreferenceDim, PreferenceFeatures, PreferenceProfile, PreferenceEvaluateOptions } from './preference';
export { PRESETS, getPreset, presetIds } from './presets';
export { STYLE_SCHEMA_VERSION } from './types';
export type {
  StylePreset,
  AgentSpec,
  MusicEvent,
  EventKind,
  RuleOrigin,
  Interval,
  HomeostasisTarget,
  WeakConstraint,
  FreeDimension,
  PitchProcessSpec,
  RhythmProcessSpec,
  TextureSpec,
  TextureKind,
} from './types';
export { hashSeed, seedString, Rng } from './rng';
export { computeFeatures, energyOf, softmaxSample, temperatureAt } from './energy';
export type { FeatureVector, SceneCtx } from './energy';
export { createPitchProcess, createRhythmProcess } from './processes';
export type { PitchProcess, RhythmProcess, PitchCtx, RhythmCtx } from './processes';
export { createAgent, scheduleAgent, samplePitches } from './agents';
export type { AgentInstance, Slot } from './agents';