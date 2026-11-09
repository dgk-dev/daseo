import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantMessageHeightEstimateCache,
  estimateAssistantMessageHeightFromCache,
  setAssistantMarkdownBlockHeight,
} from "./assistant-message-height-estimate";
import {
  clearAssistantImageMetadataCache,
  setAssistantImageMetadata,
} from "./assistant-image-metadata";

describe("assistant message height estimate", () => {
  beforeEach(() => {
    clearAssistantMessageHeightEstimateCache();
    clearAssistantImageMetadataCache();
  });

  it("estimates assistant message height from measured markdown block heights", () => {
    setAssistantMarkdownBlockHeight({
      block: "First paragraph",
      width: 804,
      height: 18.2,
    });
    setAssistantMarkdownBlockHeight({
      block: "Second paragraph",
      width: 804,
      height: 41.1,
    });

    expect(estimateAssistantMessageHeightFromCache("First paragraph\n\nSecond paragraph")).toBe(97);
  });

  it("estimates at the width the transcript was last measured at, not a fixed column", () => {
    setAssistantMarkdownBlockHeight({ block: "Wide paragraph", width: 1096, height: 22 });

    expect(estimateAssistantMessageHeightFromCache("Wide paragraph")).toBe(46);

    setAssistantMarkdownBlockHeight({ block: "Narrow paragraph", width: 700, height: 44 });

    expect(estimateAssistantMessageHeightFromCache("Wide paragraph")).toBeNull();
    expect(estimateAssistantMessageHeightFromCache("Narrow paragraph")).toBe(68);
  });

  it("falls back to image metadata when markdown blocks are not measured", () => {
    setAssistantImageMetadata(
      {
        source: "https://example.com/landscape.png",
      },
      { width: 1200, height: 800 },
    );

    expect(
      estimateAssistantMessageHeightFromCache(
        "Here is the screenshot\n\n![Screenshot](https://example.com/landscape.png)",
      ),
    ).toBeGreaterThan(220);
  });
});
