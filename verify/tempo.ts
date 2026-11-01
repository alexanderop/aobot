/** One attribute of a span, its value under the key of its type. OTLP JSON writes a 64-bit int as a string. */
interface TempoAttribute {
  readonly key: string;
  readonly value: {
    readonly stringValue?: string;
    readonly intValue?: string | number;
    readonly boolValue?: boolean;
  };
}

/** One span as Tempo returns it from `/api/v2/traces/<id>` (OTLP JSON, ids in base64). */
export interface TempoSpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly attributes?: ReadonlyArray<TempoAttribute>;
  readonly events?: ReadonlyArray<{ readonly name: string }>;
}

interface TempoTrace {
  readonly trace: {
    readonly resourceSpans: ReadonlyArray<{
      readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<TempoSpan> }>;
    }>;
  };
}

/** GET a path of Grafana's Tempo data source and read the JSON it answers. */
export async function tempo<A>(grafanaUrl: string, path: string): Promise<A> {
  const response = await fetch(`${grafanaUrl}/api/datasources/proxy/uid/tempo${path}`);

  if (!response.ok) throw new Error(`Tempo answered ${response.status} for ${path}`);

  // SAFETY: the caller names the shape Tempo's API documents. A wrong guess fails the scenario's
  // assertions, which print what came back.
  return (await response.json()) as A;
}

/** Every span of trace `traceId`, from every service that sent some. */
export async function traceSpans(
  grafanaUrl: string,
  traceId: string,
): Promise<ReadonlyArray<TempoSpan>> {
  const { trace } = await tempo<TempoTrace>(grafanaUrl, `/api/v2/traces/${traceId}`);

  return trace.resourceSpans.flatMap(({ scopeSpans }) => scopeSpans.flatMap(({ spans }) => spans));
}

/** The names from the root down to `span`. */
export function ancestry(spans: ReadonlyArray<TempoSpan>, span: TempoSpan): ReadonlyArray<string> {
  const parent = spans.find((candidate) => candidate.spanId === span.parentSpanId);

  return parent === undefined ? [span.name] : [...ancestry(spans, parent), span.name];
}

/** The value of `span`'s attribute `key` as text, whatever its type, or undefined when it has none. */
export function attribute(span: TempoSpan, key: string): string | undefined {
  const value = span.attributes?.find((candidate) => candidate.key === key)?.value;

  return [value?.stringValue, value?.intValue, value?.boolValue]
    .find((typed) => typed !== undefined)
    ?.toString();
}
