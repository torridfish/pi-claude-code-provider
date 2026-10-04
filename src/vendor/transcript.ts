/**
 * Vendored from @earendil-works/pi-ai 1.0.2 (dist/utils/transcript.js +
 * dist/utils/text.js). See ./event-stream.ts for why this copy exists:
 * `@earendil-works/pi-ai/utils/*` is not resolvable from git-installed clones.
 * The type-only import below is erased at runtime and therefore safe.
 */
import type { TranscriptMessages } from "@earendil-works/pi-ai/utils/transcript";

/** Minimal structural stand-ins — pi-ai does not re-export these types from
 *  any subpath pi's loader maps for managed installs. */
interface ContentBlock {
	type: string;
	text?: string;
}
interface ToolReferenceLike {
	name: string;
}
interface SystemMessageLike {
	role: "system";
	content: string | readonly ContentBlock[];
	sections?: Record<string, string | null>;
	toolsAdded?: readonly ToolReferenceLike[];
	toolsRemoved?: readonly ToolReferenceLike[];
	timestamp: number;
}

/** TranscriptMessages only promises `role`; system-shaped entries are
 *  SystemMessages by construction (see pi-ai utils/transcript.ts). */
function asSystemMessage(message: { role: string }): SystemMessageLike | undefined {
	return message.role === "system" ? (message as unknown as SystemMessageLike) : undefined;
}

/** Extract and join text from message content. (pi-ai utils/text.ts) */
function contentText(content: string | readonly ContentBlock[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(separator);
}

/** Render a system message as a complete prompt: its content followed by its sections. */
function getSystemMessageText(message: SystemMessageLike): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Resolve the tools available after applying every transcript delta in order. */
function getCurrentTools(messages: TranscriptMessages): ToolReferenceLike[] {
	const tools = new Map<string, ToolReferenceLike>();
	for (const message of messages) {
		const system = asSystemMessage(message);
		if (!system) continue;
		for (const tool of system.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessageLike | undefined {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	let timestamp: number | undefined;
	for (const message of messages) {
		const system = asSystemMessage(message);
		if (!system) continue;
		timestamp ??= system.timestamp;
		const text = contentText(system.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(system.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}
