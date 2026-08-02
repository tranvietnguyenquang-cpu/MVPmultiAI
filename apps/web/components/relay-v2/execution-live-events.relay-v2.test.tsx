// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayV2ExecutionLiveEvents } from "./execution-live-events.js";

const router = { refresh: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Listener = (event: Event | MessageEvent) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly close = vi.fn();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const liveEvent = (sequence: number, eventType = "OUTPUT_RECEIVED") => ({
  sequence,
  eventType,
  level: "INFO",
  message: `event ${sequence}`,
  createdAt: `2026-08-02T00:00:0${sequence}.000Z`
});

describe("RelayV2ExecutionLiveEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    router.refresh.mockReset();
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("allows native reconnect, deduplicates resumed events, and closes after terminal delivery", () => {
    render(<RelayV2ExecutionLiveEvents
      sessionId="session-1"
      projectId="11111111-1111-4111-8111-111111111111"
      initialEvents={[]}
      terminal={false}
    />);

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain("cursor=0");

    act(() => source.emit("execution", liveEvent(1)));
    act(() => source.onerror?.(new Event("error")));
    expect(source.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.queryByText("Reconnecting to persisted execution events...")).toBeNull();

    act(() => source.onerror?.(new Event("error")));
    expect(screen.getByText("Reconnecting to persisted execution events...")).toBeTruthy();
    act(() => source.onopen?.(new Event("open")));
    expect(screen.queryByText("Reconnecting to persisted execution events...")).toBeNull();

    act(() => source.emit("execution", liveEvent(1)));
    act(() => source.emit("execution", liveEvent(2, "EXECUTION_SUCCEEDED")));
    expect(screen.getAllByText("#1 OUTPUT_RECEIVED")).toHaveLength(1);
    expect(screen.getByText("#2 EXECUTION_SUCCEEDED")).toBeTruthy();

    act(() => source.emit("complete", { status: "SUCCEEDED", cursor: 2 }));
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("closes the sole EventSource connection when unmounted", () => {
    const view = render(<RelayV2ExecutionLiveEvents
      sessionId="session-2"
      projectId="11111111-1111-4111-8111-111111111111"
      initialEvents={[]}
      terminal={false}
    />);
    const source = FakeEventSource.instances[0]!;
    view.unmount();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
