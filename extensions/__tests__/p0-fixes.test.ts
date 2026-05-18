import { describe, it, expect } from "vitest";
import { splitMessage } from "../helpers.js";

// ─── splitMessage: code-fence preservation (P0 #1) ──────────────────────────

describe("splitMessage: code-fence preservation", () => {
  it("preserves a closed code block within a single chunk", () => {
    const code = "```ts\nconsole.log('hi');\n```";
    const chunks = splitMessage(code, 1900);
    expect(chunks).toEqual([code]);
  });

  it("closes an open fence at chunk boundary and reopens in next chunk", () => {
    // Build a string where a code fence opens near the start and the chunk
    // boundary falls inside the fence.
    const fenceOpen = "```ts\n";
    const lines = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`);
    const codeBlock = lines.join("\n");
    const fenceClose = "\n```";
    const after = "\nSome text after the code block.";

    const full = fenceOpen + codeBlock + fenceClose + after;
    const chunks = splitMessage(full, 500);

    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk should have balanced fences (even count of ```)
    for (let i = 0; i < chunks.length; i++) {
      const fenceCount = countTripleBackticks(chunks[i]);
      expect(fenceCount % 2, `Chunk ${i} has unbalanced fences`).toBe(0);
    }

    // Reassembled content (minus fence closes/reopens) should preserve code
    const reassembled = chunks.join("\n");
    // The original code lines should all be present
    for (const line of lines) {
      expect(reassembled).toContain(line);
    }
  });

  it("preserves multiple code blocks split across chunks", () => {
    const block1 = "```js\n" + "a\n".repeat(200) + "```\n";
    const block2 = "```py\n" + "b\n".repeat(200) + "```\n";
    const full = block1 + block2;

    const chunks = splitMessage(full, 400);
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length; i++) {
      const fenceCount = countTripleBackticks(chunks[i]);
      expect(fenceCount % 2, `Chunk ${i} has unbalanced fences`).toBe(0);
    }
  });

  it("reopens with the same language info string", () => {
    const code = "```typescript\n" + "x\n".repeat(600) + "```\n";
    const chunks = splitMessage(code, 300);

    // The second chunk should reopen with ```typescript
    const joined = chunks.join("|||SPLIT|||");
    // Should contain the language tag at least twice (open + reopen)
    const tsFences = joined.match(/```typescript/g) ?? [];
    expect(tsFences.length).toBeGreaterThanOrEqual(2);
  });

  it("handles inline backticks without affecting fence state", () => {
    const text = "Use `code` here.\n```ts\n" + "x\n".repeat(400) + "```\n";
    const chunks = splitMessage(text, 300);

    for (let i = 0; i < chunks.length; i++) {
      const fenceCount = countTripleBackticks(chunks[i]);
      expect(fenceCount % 2, `Chunk ${i} has unbalanced fences`).toBe(0);
    }
  });

  it("does not add fences when text has none", () => {
    const text = "a\n".repeat(100);
    const chunks = splitMessage(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("```");
    }
  });

  it("handles a lone ``` at the very end of a chunk", () => {
    // Construct text where the chunk boundary is right after an opening fence
    const header = "```ts\n";
    const body = "const x = 1;\n".repeat(100);
    const full = header + body;

    const chunks = splitMessage(full, 200);
    for (let i = 0; i < chunks.length; i++) {
      const fenceCount = countTripleBackticks(chunks[i]);
      expect(fenceCount % 2, `Chunk ${i} has unbalanced fences`).toBe(0);
    }
  });
});

/** Count occurrences of ``` (triple backtick sequences) in text. */
function countTripleBackticks(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (text.slice(i, i + 3) === "```") {
      count++;
      i += 3;
    } else {
      i++;
    }
  }
  return count;
}
