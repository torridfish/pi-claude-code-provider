/**
 * Serialize a pi transcript into the single user message a headless claude
 * child receives.
 *
 * A request to this provider is one turn of a conversation pi owns: pi holds
 * the transcript, claude does not. `claude -p --input-format stream-json`
 * accepts only user messages on stdin, so the whole history — tool calls and
 * results included — travels in as one structured dump, and the child reads
 * it as the conversation to continue. The reply that comes back is the next
 * assistant message of that transcript.
 */
import type { Message } from "@earendil-works/pi-ai/compat";

/** How much of a tool result survives serialization. A tool result pi already
 *  truncated still travels in full here; this only stops a pathological one
 *  from drowning everything after it. */
const RESULT_LIMIT = 8000;

const ARGUMENTS_LIMIT = 400;

export const TRANSCRIPT_HEADER = [
	"The following is a transcript of an ongoing conversation between a user and an assistant (you),",
	"enclosed in <transcript>. Tool calls were executed by the host application and their results appear inline.",
	"Read it and continue the conversation as the assistant: reply with only your next message to the user,",
	"not a commentary on the transcript. Tool execution is handled by the Claude Code harness; use your own tools.",
].join(" ");

/** Cut at a character boundary rather than mid code point. */
function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return text.slice(0, limit - 1) + "…";
}

function flatten(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text" && c.text)
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

export function serializeMessage(message: Message): string | undefined {
	if (message.role === "system") return undefined;
	if (message.role === "user") {
		const text = flatten(message.content);
		const images = Array.isArray(message.content) ? message.content.filter((c: any) => c.type === "image").length : 0;
		const parts = [text.trim() && `[user]: ${truncate(text.trim(), RESULT_LIMIT)}`];
		if (images) parts.push(`[user attached ${images} image${images === 1 ? "" : "s"} — not reproduced in this transcript]`);
		const out = parts.filter(Boolean).join("\n");
		return out || undefined;
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) parts.push(`[assistant]: ${truncate(block.text.trim(), RESULT_LIMIT)}`);
			// Past thinking belongs to pi's record of the turn, not to a prompt for
			// the next one; claude does its own thinking.
			if (block.type === "toolCall") {
				parts.push(`[assistant used tool ${block.name}] ${truncate(JSON.stringify(block.arguments), ARGUMENTS_LIMIT)}`);
			}
		}
		return parts.join("\n") || undefined;
	}
	if (message.role === "toolResult") {
		const text = truncate(flatten(message.content), RESULT_LIMIT);
		if (!text.trim()) return undefined;
		return `[tool ${message.toolName} ${message.isError ? "error" : "result"}]: ${text}`;
	}
	return undefined;
}

export function serializeTranscript(messages: readonly Message[]): string {
	const body = messages
		.map(serializeMessage)
		.filter((s): s is string => s !== undefined)
		.join("\n\n");
	return `<transcript>\n${TRANSCRIPT_HEADER}\n\n${body}\n\n[end of transcript — continue as the assistant]`;
}
