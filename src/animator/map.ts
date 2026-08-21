/**
 * animator/map.ts — an AnimatorController as states and transitions, with the two facts nobody can see.
 *
 * A `.controller` is the same YAML dialect as a prefab and just as opaque: states, transitions and the
 * state machine are separate documents joined by fileIDs, the clip on a state is a guid, and the numbers
 * that decide BEHAVIOUR are spread across three of those documents. So the questions an animation bug
 * actually turns on cannot be answered by reading the file:
 *
 *   · **Does this transition wait for the clip to finish?** `m_HasExitTime: 0` means it fires the moment
 *     its conditions are met — it cuts the clip mid-play. This is the single most common cause of "the
 *     animation is skipping" and it is one digit, thirty lines away from the state it belongs to.
 *   · **Do the clips OVERLAP?** A transition duration greater than zero is a cross-fade: both clips play
 *     at once for that long. Worse, the duration is in NORMALIZED time unless `m_HasFixedDuration` is
 *     set, so `0.25` means a quarter of the source clip — and the source clip's length lives in yet
 *     another file. Reported here in seconds, with the arithmetic done.
 *   · **What triggers it?** `m_ConditionMode: 1` on `m_ConditionEvent: isWinning` is "if the
 *     trigger isWinning is set". The mode is an enum nobody remembers.
 *
 * READ-ONLY, deliberately. A controller edit is a graph edit — retargeting a transition means touching
 * three documents and Unity's own ids — and nothing here writes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectRefs, entry, parseRef, parseUnityYaml, type YDocument, type YEntry, type YFile } from '../prefab/yaml.js';
import { relToRoot, resolveGuids, type AssetRef } from '../prefab/refs.js';

const CONTROLLER = 91;
const STATE = 1102;
const TRANSITION = 1101;
const STATE_MACHINE = 1107;
const ENTRY_TRANSITION = 1109;
const BLEND_TREE = 206;

/** Unity's AnimatorControllerParameterType. */
const PARAM_TYPE: Record<string, string> = { '1': 'Float', '3': 'Int', '4': 'Bool', '9': 'Trigger' };

/** Unity's AnimatorConditionMode, as the sentence the Inspector shows. */
const CONDITION_MODE: Record<string, string> = {
  '1': 'is set', '2': 'is not set', '3': 'greater than', '4': 'less than', '6': 'equals', '7': 'not equal',
};

/** Unity's TransitionInterruptionSource. */
const INTERRUPTION: Record<string, string> = {
  '0': 'none', '1': 'source', '2': 'destination', '3': 'source then destination', '4': 'destination then source',
};

export interface AnimatorParameter {
  name: string;
  type: string;
  default: string;
}

export interface ClipInfo {
  /** The AnimationClip asset, when the motion is one. */
  asset?: AssetRef;
  /** A guid with no asset behind it — the state plays nothing. */
  missing?: string;
  /** A BlendTree lives INSIDE the controller, so it has a name and no file. */
  blendTree?: string;
  /** Seconds, from the clip's own `m_StopTime` minus `m_StartTime`. Absent when the clip was unreadable. */
  lengthSeconds?: number;
  loops?: boolean;
}

export interface TransitionCondition {
  parameter: string;
  /** `is set`, `greater than`, … — the enum, spelled. */
  mode: string;
  threshold: string;
}

export interface TransitionInfo {
  from: string;
  to: string;
  /** False means it fires as soon as its conditions hold, cutting the source clip wherever it is. */
  hasExitTime: boolean;
  /** Normalized position in the source clip where it may fire. */
  exitTime: number;
  exitTimeSeconds?: number;
  /** As serialized: seconds when `durationIsFixed`, otherwise a fraction of the SOURCE clip. */
  duration: number;
  durationIsFixed: boolean;
  durationSeconds?: number;
  offset: number;
  conditions: TransitionCondition[];
  interruptionSource: string;
  orderedInterruption: boolean;
  canTransitionToSelf: boolean;
  muted: boolean;
  solo: boolean;
  /** The answer to "do the clips overlap", with the arithmetic already done. */
  overlap: {
    clipsOverlap: boolean;
    seconds?: number;
    /** True when the cross-fade runs past the end of the source clip. */
    exceedsSourceClip?: boolean;
    note: string;
  };
}

export interface StateInfo {
  name: string;
  /** The state the layer starts in. */
  isDefault: boolean;
  speed: number;
  cycleOffset: number;
  tag: string;
  writeDefaultValues: boolean;
  clip: ClipInfo;
  transitions: TransitionInfo[];
}

export interface LayerInfo {
  name: string;
  defaultState: string;
  weight: number;
  ikPass: boolean;
  states: StateInfo[];
  /** Transitions that can fire from ANY state — the ones people forget when a state "leaves early". */
  anyStateTransitions: TransitionInfo[];
  entryTransitions: TransitionInfo[];
}

export interface AnimatorMap {
  file: string;
  parameters: AnimatorParameter[];
  layers: LayerInfo[];
  /** Facts worth acting on that are only visible once the graph is assembled. */
  findings: string[];
}

const num = (v: string | undefined, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const flag = (v: string | undefined): boolean => v === '1';

/** A clip's length and loop flag, from its own `.anim`. Bounded read: a clip file is curves, not prose. */
function clipTiming(abs: string): { lengthSeconds?: number; loops?: boolean } {
  if (!existsSync(abs)) return {};
  try {
    const text = readFileSync(abs, 'utf-8');
    const start = /m_StartTime:\s*(-?[\d.eE+-]+)/.exec(text);
    const stop = /m_StopTime:\s*(-?[\d.eE+-]+)/.exec(text);
    const loop = /m_LoopTime:\s*(\d)/.exec(text);
    if (!stop) return { loops: loop ? loop[1] === '1' : undefined };
    return {
      lengthSeconds: Math.max(0, num(stop[1]) - num(start?.[1], 0)),
      loops: loop ? loop[1] === '1' : undefined,
    };
  } catch { return {}; }
}

interface Ctx {
  root: string;
  refs: Map<string, AssetRef>;
  byId: Map<string, YDocument>;
  /** Clip path → timing, so a controller reusing one clip in ten states reads it once. */
  timing: Map<string, { lengthSeconds?: number; loops?: boolean }>;
}

function motionOf(state: YDocument, ctx: Ctx): ClipInfo {
  const raw = entry(state.body, 'm_Motion')?.raw ?? '';
  const ref = parseRef(raw);
  if (!ref || ref.fileId === '0') return {};
  if (ref.guid) {
    const asset = ctx.refs.get(ref.guid);
    if (!asset) return { missing: ref.guid };
    const abs = join(ctx.root, asset.path);
    let timing = ctx.timing.get(abs);
    if (!timing) { timing = clipTiming(abs); ctx.timing.set(abs, timing); }
    return { asset, ...timing };
  }
  // A local fileID: a BlendTree serialized inside the controller.
  const local = ctx.byId.get(ref.fileId);
  if (local?.classId === BLEND_TREE) {
    return { blendTree: entry(local.body, 'm_Name')?.raw || '(unnamed blend tree)' };
  }
  return {};
}

const nameOfState = (doc: YDocument | undefined): string =>
  doc ? entry(doc.body, 'm_Name')?.raw || '(unnamed state)' : '(missing state)';

function conditionsOf(doc: YDocument): TransitionCondition[] {
  const conds = entry(doc.body, 'm_Conditions');
  if (!conds) return [];
  return conds.children.map((item) => ({
    parameter: entry(item.value.children, 'm_ConditionEvent')?.raw ?? '',
    mode: CONDITION_MODE[entry(item.value.children, 'm_ConditionMode')?.raw ?? ''] ?? `mode ${entry(item.value.children, 'm_ConditionMode')?.raw ?? '?'}`,
    threshold: entry(item.value.children, 'm_EventTreshold')?.raw ?? '',
  }));
}

/**
 * One transition, with the overlap arithmetic.
 *
 * `sourceClip` is what makes a normalized duration mean anything: Unity stores 0.25 for "a quarter of the
 * clip I am leaving", and without the clip's length that number cannot be compared to anything.
 */
function transitionOf(doc: YDocument, from: string, sourceClip: ClipInfo, ctx: Ctx): TransitionInfo {
  const dstId = parseRef(entry(doc.body, 'm_DstState')?.raw ?? '')?.fileId ?? '0';
  const dstMachineId = parseRef(entry(doc.body, 'm_DstStateMachine')?.raw ?? '')?.fileId ?? '0';
  const isExit = flag(entry(doc.body, 'm_IsExit')?.raw);
  const to = dstId !== '0'
    ? nameOfState(ctx.byId.get(dstId))
    : dstMachineId !== '0'
      ? `(sub-state machine ${entry(ctx.byId.get(dstMachineId)?.body ?? [], 'm_Name')?.raw ?? '?'})`
      : isExit ? '(exit)' : '(nothing — this transition goes nowhere)';

  const hasExitTime = flag(entry(doc.body, 'm_HasExitTime')?.raw);
  const exitTime = num(entry(doc.body, 'm_ExitTime')?.raw);
  const duration = num(entry(doc.body, 'm_TransitionDuration')?.raw);
  const durationIsFixed = flag(entry(doc.body, 'm_HasFixedDuration')?.raw);
  const length = sourceClip.lengthSeconds;

  const durationSeconds = durationIsFixed
    ? duration
    : length !== undefined ? duration * length : undefined;
  const exitTimeSeconds = length !== undefined ? exitTime * length : undefined;

  const clipsOverlap = (durationSeconds ?? duration) > 0;
  /**
   * A POSE IS NOT A TIMELINE. A single-frame idle clip has length 0, so any cross-fade into it trivially
   * "runs past its end" — and reporting that turned a normal 0.25s fade into a pose clip into a finding on
   * a real controller. Overlap past the end only means something when there is a clip to run past.
   */
  const exceedsSourceClip = clipsOverlap && durationSeconds !== undefined && exitTimeSeconds !== undefined
    && length !== undefined && length > 0 && exitTimeSeconds + durationSeconds > length + 1e-6;

  const notes: string[] = [];
  if (clipsOverlap) {
    notes.push(durationSeconds !== undefined
      ? `both clips play for ${durationSeconds.toFixed(3)}s`
      : `cross-fades over ${duration} (normalized — the source clip's length is unknown, so this cannot be given in seconds)`);
  } else {
    notes.push('no cross-fade: the destination replaces the source in one frame');
  }
  if (!hasExitTime) notes.push('no exit time: it fires as soon as its conditions hold, cutting the source clip wherever it is');
  else if (exitTime < 1) notes.push(`the source clip is left at ${(exitTime * 100).toFixed(1)}% of its length`);
  if (exceedsSourceClip) notes.push('the cross-fade runs PAST the end of the source clip — a non-looping clip holds its last frame through the rest of it');

  return {
    from, to, hasExitTime, exitTime, exitTimeSeconds,
    duration, durationIsFixed, durationSeconds,
    offset: num(entry(doc.body, 'm_TransitionOffset')?.raw),
    conditions: conditionsOf(doc),
    interruptionSource: INTERRUPTION[entry(doc.body, 'm_InterruptionSource')?.raw ?? '0'] ?? 'unknown',
    orderedInterruption: flag(entry(doc.body, 'm_OrderedInterruption')?.raw),
    canTransitionToSelf: flag(entry(doc.body, 'm_CanTransitionToSelf')?.raw),
    muted: flag(entry(doc.body, 'm_Mute')?.raw),
    solo: flag(entry(doc.body, 'm_Solo')?.raw),
    overlap: { clipsOverlap, seconds: durationSeconds, exceedsSourceClip, note: notes.join('; ') },
  };
}

const refIds = (e: YEntry | undefined): string[] => {
  if (!e) return [];
  return e.value.children
    .flatMap((c) => [...c.value.raw.matchAll(/fileID:\s*(-?\d+)/g)].map((m) => m[1]))
    .filter((id) => id !== '0');
};

/** `m_ChildStates` items are maps: `- m_State: {fileID: …}` plus a position. */
function childStateIds(machine: YDocument): string[] {
  const kids = entry(machine.body, 'm_ChildStates');
  if (!kids) return [];
  return kids.children
    .map((item) => parseRef(entry(item.value.children, 'm_State')?.raw ?? '')?.fileId)
    .filter((id): id is string => Boolean(id) && id !== '0');
}

function statesOfMachine(machine: YDocument, prefix: string, ctx: Ctx): { states: StateInfo[]; defaultState: string } {
  const defaultId = parseRef(entry(machine.body, 'm_DefaultState')?.raw ?? '')?.fileId ?? '0';
  const states: StateInfo[] = [];

  for (const id of childStateIds(machine)) {
    const doc = ctx.byId.get(id);
    if (!doc || doc.classId !== STATE) continue;
    const name = `${prefix}${nameOfState(doc)}`;
    const clip = motionOf(doc, ctx);
    const transitions = refIds(doc.body.find((e) => e.key === 'm_Transitions'))
      .map((tid) => ctx.byId.get(tid))
      .filter((t): t is YDocument => t !== undefined && t.classId === TRANSITION)
      .map((t) => transitionOf(t, name, clip, ctx));
    states.push({
      name,
      isDefault: id === defaultId,
      speed: num(entry(doc.body, 'm_Speed')?.raw, 1),
      cycleOffset: num(entry(doc.body, 'm_CycleOffset')?.raw),
      tag: entry(doc.body, 'm_Tag')?.raw ?? '',
      writeDefaultValues: flag(entry(doc.body, 'm_WriteDefaultValues')?.raw),
      clip,
      transitions,
    });
  }

  // A sub-state machine is a machine like any other; its states are named through it so two states called
  // "Idle" in different machines stay distinguishable.
  const children = entry(machine.body, 'm_ChildStateMachines');
  for (const item of children?.children ?? []) {
    const smId = parseRef(entry(item.value.children, 'm_StateMachine')?.raw ?? '')?.fileId;
    const sm = smId ? ctx.byId.get(smId) : undefined;
    if (!sm || sm.classId !== STATE_MACHINE) continue;
    const inner = statesOfMachine(sm, `${prefix}${entry(sm.body, 'm_Name')?.raw ?? '?'}/`, ctx);
    states.push(...inner.states);
  }

  const defaultDoc = defaultId !== '0' ? ctx.byId.get(defaultId) : undefined;
  return { states, defaultState: defaultDoc ? `${prefix}${nameOfState(defaultDoc)}` : '' };
}

/**
 * What is only visible once the graph is assembled.
 *
 * Each of these is a real bug shape rather than a style preference: a state nothing enters is dead
 * animation, a state nothing leaves is a stuck layer, and a conditionless transition with no exit time
 * fires on the frame the state is entered — which reads as "the animation never plays".
 */
function findingsFor(layers: LayerInfo[]): string[] {
  const out: string[] = [];
  for (const layer of layers) {
    const incoming = new Set<string>();
    const anyState = layer.anyStateTransitions.length > 0;
    for (const s of layer.states) for (const t of s.transitions) incoming.add(t.to);
    for (const t of layer.entryTransitions) incoming.add(t.to);
    for (const t of layer.anyStateTransitions) incoming.add(t.to);

    for (const s of layer.states) {
      if (!s.isDefault && !incoming.has(s.name)) {
        out.push(`${layer.name}: nothing transitions INTO "${s.name}" and it is not the default state — it can never play`);
      }
      if (s.transitions.length === 0 && !anyState) {
        out.push(`${layer.name}: nothing leaves "${s.name}" and the layer has no Any-State transitions — once entered, the layer stays there`);
      }
      for (const t of s.transitions) {
        if (t.conditions.length === 0 && !t.hasExitTime) {
          out.push(`${layer.name}: "${t.from}" → "${t.to}" has NO conditions and NO exit time — it fires the frame the state is entered`);
        }
        if (t.overlap.exceedsSourceClip) {
          out.push(`${layer.name}: "${t.from}" → "${t.to}" cross-fades past the end of "${t.from}" (exit ${t.exitTimeSeconds?.toFixed(3)}s + fade ${t.overlap.seconds?.toFixed(3)}s > clip ${s.clip.lengthSeconds?.toFixed(3)}s)`);
        }
        if (t.muted) out.push(`${layer.name}: "${t.from}" → "${t.to}" is MUTED — it is in the file and never fires`);
      }
      if (s.clip.missing) out.push(`${layer.name}: "${s.name}" has a motion guid nothing in the project defines (${s.clip.missing}) — it plays nothing`);
    }
  }
  return out;
}

function guidsIn(file: YFile): Set<string> {
  const out = new Set<string>();
  for (const doc of file.documents) {
    for (const e of doc.body) for (const ref of collectRefs(e.value)) if (ref.guid) out.add(ref.guid);
  }
  return out;
}

export async function buildAnimatorMap(abs: string, opts: { root: string }): Promise<AnimatorMap> {
  const file = parseUnityYaml(abs, readFileSync(abs, 'utf-8'));
  const refs = await resolveGuids(opts.root, guidsIn(file));
  const ctx: Ctx = {
    root: opts.root, refs,
    byId: new Map(file.documents.map((d) => [d.fileId, d])),
    timing: new Map(),
  };

  const controller = file.documents.find((d) => d.classId === CONTROLLER);
  const parameters: AnimatorParameter[] = [];
  for (const item of entry(controller?.body ?? [], 'm_AnimatorParameters')?.children ?? []) {
    const type = entry(item.value.children, 'm_Type')?.raw ?? '';
    const named = PARAM_TYPE[type] ?? `type ${type}`;
    const defaults: Record<string, string | undefined> = {
      Float: entry(item.value.children, 'm_DefaultFloat')?.raw,
      Int: entry(item.value.children, 'm_DefaultInt')?.raw,
      Bool: entry(item.value.children, 'm_DefaultBool')?.raw,
      Trigger: entry(item.value.children, 'm_DefaultBool')?.raw,
    };
    parameters.push({
      name: entry(item.value.children, 'm_Name')?.raw ?? '',
      type: named,
      default: defaults[named] ?? '',
    });
  }

  const layers: LayerInfo[] = [];
  for (const item of entry(controller?.body ?? [], 'm_AnimatorLayers')?.children ?? []) {
    const smId = parseRef(entry(item.value.children, 'm_StateMachine')?.raw ?? '')?.fileId;
    const machine = smId ? ctx.byId.get(smId) : undefined;
    const layerName = entry(item.value.children, 'm_Name')?.raw ?? '(unnamed layer)';
    if (!machine || machine.classId !== STATE_MACHINE) {
      layers.push({
        name: layerName, defaultState: '', weight: num(entry(item.value.children, 'm_DefaultWeight')?.raw),
        ikPass: flag(entry(item.value.children, 'm_IKPass')?.raw),
        states: [], anyStateTransitions: [], entryTransitions: [],
      });
      continue;
    }
    const { states, defaultState } = statesOfMachine(machine, '', ctx);
    // An Any-State transition has no source clip, so its normalized duration cannot be resolved to
    // seconds — which is itself worth saying rather than printing a number that means something else.
    const anyState = refIds(machine.body.find((e) => e.key === 'm_AnyStateTransitions'))
      .map((id) => ctx.byId.get(id))
      .filter((d): d is YDocument => d !== undefined && d.classId === TRANSITION)
      .map((d) => transitionOf(d, 'Any State', {}, ctx));
    const entryTransitions = refIds(machine.body.find((e) => e.key === 'm_EntryTransitions'))
      .map((id) => ctx.byId.get(id))
      .filter((d): d is YDocument => d !== undefined && (d.classId === ENTRY_TRANSITION || d.classId === TRANSITION))
      .map((d) => transitionOf(d, 'Entry', {}, ctx));

    layers.push({
      name: layerName,
      defaultState,
      weight: num(entry(item.value.children, 'm_DefaultWeight')?.raw),
      ikPass: flag(entry(item.value.children, 'm_IKPass')?.raw),
      states, anyStateTransitions: anyState, entryTransitions,
    });
  }

  return { file: relToRoot(opts.root, abs), parameters, layers, findings: findingsFor(layers) };
}

/** Only the one extension. A `.controller` is the only file that holds an AnimatorController. */
export function isAnimatorController(path: string): boolean {
  return /\.controller$/i.test(path);
}
