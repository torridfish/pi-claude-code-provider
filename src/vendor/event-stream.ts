/**
 * Vendored from @earendil-works/pi-ai 1.0.2 (dist/utils/event-stream.js).
 *
 * WHY: pi's extension loader (jiti) maps only a fixed set of pi-ai subpaths
 * for managed npm/git installs — `@earendil-works/pi-ai`, `/compat`,
 * `/oauth`, `/providers/all` — and its alias substitution is prefix-based, so
 * any other subpath (`utils/*`) resolves to a bogus path inside a git-installed
 * clone, which has no node_modules of its own ("Cannot find module"). Dev
 * checkouts only work because their local node_modules happens to contain
 * pi-ai. This copy is small and dependency-free; the type-only import below is
 * erased at runtime and therefore safe under jiti.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream as HostAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];
	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}
	enqueue(value: T): void {
		this.incoming.push(value);
	}
	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

/** Generic event stream class for async iteration. */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(result: IteratorResult<T>) => void>();
	private done = false;
	private finalResultPromise!: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise<R>((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}
		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/**
 * Factory for the stream the provider hands back to pi. The vendored class is
 * structurally identical to pi-ai's but a distinct declaration (private
 * fields), so the boundary is bridged with a cast; pi's host consumes the
 * stream duck-typed (no `instanceof` checks).
 */
export function createAssistantMessageEventStream(): HostAssistantMessageEventStream {
	return new AssistantMessageEventStream() as unknown as HostAssistantMessageEventStream;
}
