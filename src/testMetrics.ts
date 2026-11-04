import { register } from "./metrics";

/**
 * The `_count` of one histogram series, read from the text that /metrics
 * serves. A series with that label set that does not exist yet counts 0.
 */
export async function histogramCount(
  name: string,
  labels: Record<string, string>
): Promise<number> {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of (await register.metrics()).split("\n")) {
    if (!line.startsWith(`${name}_count{`)) continue;
    if (wanted.every((pair) => line.includes(pair))) {
      return Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return 0;
}

/**
 * The series of one gauge (or counter), read from the text that /metrics
 * serves: the labels and the value of each line with that exact name.
 */
export async function gaugeValues(
  name: string
): Promise<{ labels: Record<string, string>; value: number }[]> {
  const series: { labels: Record<string, string>; value: number }[] = [];
  for (const line of (await register.metrics()).split("\n")) {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/);
    if (!match || match[1] !== name) continue;
    const labels: Record<string, string> = {};
    const pair = /(\w+)="([^"]*)"/g;
    let found: RegExpExecArray | null;
    while ((found = pair.exec(match[2] ?? ""))) labels[found[1]] = found[2];
    series.push({ labels, value: Number(match[3]) });
  }
  return series;
}
