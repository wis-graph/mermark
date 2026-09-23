// sample.ts — mock-assets/mock/vault/sample.ts fixture (20 lines — gcode asserts this line count)
import type { Reader } from "./types";

/**
 * 안녕 인사를 만든다.
 */
export function greet(name: string): string {
  const greeting = "안녕";
  return `${greeting}, ${name}!`;
}

export function answer(): number {
  return 42;
}

export function double(reader: Reader, n: number): number {
  return n * 2;
}

export const VERSION = "1.0.0";
