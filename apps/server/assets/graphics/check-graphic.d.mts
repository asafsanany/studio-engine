// Types of check-graphic.mjs, the check a graphic run does on its own work (GR2), for its tests.

export interface CheckSize {
  name: '9x16' | '16x9' | '1x1';
  label: string;
  width: number;
  height: number;
}

export const CHECK_SIZES: readonly CheckSize[];
export const TAIL_SEC: number;
export const AFTER_END_SEC: number;

export function seconds(value: number): string;

export type CheckArgs =
  | { id: string; lengthSec: number; at: number[]; vars: Record<string, unknown> }
  | { error: string };

export function parseArgs(argv: readonly string[]): CheckArgs;

export function checkHostHtml(options: {
  id: string;
  lengthSec: number;
  width: number;
  height: number;
  vars?: Record<string, unknown>;
}): string;

export function lintReport(output: string): { errors: number; lines: string[] };

export function fieldIds(html: string): { ids: string[] } | { error: string };

export function emptyFieldMoments(at: readonly number[], lengthSec: number): number[];
